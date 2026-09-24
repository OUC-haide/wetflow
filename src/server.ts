#!/usr/bin/env node
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import type { FastifyReply } from 'fastify'
import fastifyStatic from '@fastify/static'
import { createWetFlowContext } from './cordis.js'
import type { AgentEvent } from './core/types.js'
import type { ReasoningEffort } from './agent/provider.js'
import { OpenAICompatibleProvider } from './agent/provider.js'
import type { ToolRegistry } from './agent/tools.js'
import { registerIndustrialTools } from './agent/industrial-tools.js'
import { registerModelingTools } from './agent/modeling-tools.js'
import { registerResearchTools } from './agent/research-tools.js'
import { registerResearchRoutes } from './research/routes.js'
import { ResearchStore } from './research/store.js'
import { ResearchService } from './research/service.js'
import { ModelingService } from './modeling/service.js'
import { IndustrialSettingsManager, IndustrialStore } from './industrial/index.js'
import type {
  ActionInput,
  BatchProfileInput,
  ConnectorInput,
  DeviationInput,
  DeviationResolutionInput,
  DeviationStatus,
  EntityInput,
  GenealogyInput,
  IndustrialActor,
  IndustrialSettings,
  LotInput,
  ParameterInput,
  PredictionInput,
  TelemetryInput,
} from './industrial/index.js'

export interface ServerOptions {
  host?: string
  port?: number
  dbPath?: string
  serveWeb?: boolean
  settingsPath?: string
  contextTokenBudget?: number
  industrialSettingsPath?: string
  industrialDbPath?: string
  modelingDataDir?: string
  researchDbPath?: string
}

interface StoredModelSettings {
  provider: 'openai-compatible'
  baseUrl: string
  apiKey: string
  model: string
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Industrial requests carry their actor in development headers until a real
 * identity provider is wired in; the overview reports this as identityMode.
 */
function actorFrom(headers: Record<string, string | string[] | undefined>): IndustrialActor {
  return {
    id: headerValue(headers['x-wetflow-actor']) ?? 'local-operator',
    role: headerValue(headers['x-wetflow-role']) ?? 'operator',
  }
}

function readModelSettings(path: string): StoredModelSettings | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredModelSettings>
    if (parsed.provider !== 'openai-compatible' || !parsed.baseUrl || !parsed.apiKey || !parsed.model) return undefined
    return { provider: parsed.provider, baseUrl: parsed.baseUrl, apiKey: parsed.apiKey, model: parsed.model }
  } catch {
    return undefined
  }
}

function writeModelSettings(path: string, settings: StoredModelSettings): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* Windows may ignore POSIX modes. */ }
}

function publicModelSettings(settings: StoredModelSettings | undefined) {
  return {
    provider: settings?.provider ?? 'openai-compatible',
    baseUrl: settings?.baseUrl ?? '',
    model: settings?.model ?? '',
    hasApiKey: Boolean(settings?.apiKey),
    configured: Boolean(settings?.baseUrl && settings?.apiKey && settings?.model),
  }
}

function storedIndustrialDatabase(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { database?: { path?: unknown } }
    const value = parsed.database?.path
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Writes a modeling prediction through IndustrialStore. The job-derived
 * `artifactRef` doubles as a persisted idempotency key: if the prediction row was
 * written but the modeling task update did not survive, a retry (even after a
 * restart) resolves the existing row instead of duplicating it. Linking an
 * experiment stays a separate, explicit step and never marks the prediction tested.
 */
export function createModelingPrediction(
  store: IndustrialStore,
  runId: string,
  input: Record<string, unknown>,
): { id: string } {
  const artifactRef = typeof input.artifactRef === 'string' ? input.artifactRef.trim() : ''
  if (artifactRef) {
    const existing = store.predictionByArtifact(runId, artifactRef)
    if (existing) return { id: existing.id }
  }
  return store.addPrediction(runId, {
    model: String(input.model ?? 'local-modeling'), artifactRef: input.artifactRef,
    prediction: input.prediction, conditions: input.conditions, uncertainty: input.uncertainty,
    reason: input.reason,
  }, { id: 'wetflow-modeling-agent', role: 'application' })
}

export async function createServer(options: ServerOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 3_000_000 })
  const settingsPath = options.settingsPath ?? process.env.WETFLOW_SETTINGS_FILE ?? '.wetflow/model-settings.json'
  let modelSettings = readModelSettings(settingsPath)
  if (!modelSettings) {
    const baseUrl = process.env.WETFLOW_MODEL_BASE_URL?.trim() ?? ''
    const apiKey = process.env.WETFLOW_MODEL_API_KEY?.trim() ?? ''
    const model = process.env.WETFLOW_MODEL?.trim() ?? ''
    if (baseUrl && apiKey && model) modelSettings = { provider: 'openai-compatible', baseUrl, apiKey, model }
  }
  const contextTokenBudget = options.contextTokenBudget ?? (process.env.WETFLOW_CONTEXT_TOKEN_BUDGET
    ? Number(process.env.WETFLOW_CONTEXT_TOKEN_BUDGET)
    : undefined)
  // The industrial store and run resolver only exist after the agent context is
  // built, so registration captures lazy accessors instead of values.
  const workflowDbPath = options.dbPath ?? process.env.WETFLOW_DB ?? '.wetflow/wetflow-agent.db'
  let resolveIndustrialRunId: ((candidate?: unknown) => string) | undefined
  let openIndustrialStore: (() => IndustrialStore) | undefined
  let researchService: ResearchService | undefined
  const registerAgentTools = (registry: ToolRegistry): void => {
    registerIndustrialTools(registry, {
      store: () => {
        if (!openIndustrialStore) throw new Error('工业存储尚未就绪。')
        return openIndustrialStore()
      },
      resolveRunId: candidate => {
        if (!resolveIndustrialRunId) throw new Error('工作流运行上下文尚未就绪。')
        return resolveIndustrialRunId(candidate)
      },
      actor: { id: 'wetflow-agent', role: 'agent' },
    })
  }
  const ctx = await createWetFlowContext({
    dbPath: workflowDbPath,
    modelBaseUrl: modelSettings?.baseUrl ?? '',
    modelApiKey: modelSettings?.apiKey ?? '',
    model: modelSettings?.model ?? '',
    models: (process.env.WETFLOW_MODELS ?? '').split(',').map(value => value.trim()).filter(Boolean),
    ...(contextTokenBudget ? { contextTokenBudget } : {}),
    registerTools: registerAgentTools,
    additionalContext: runId => researchService?.context(runId) ?? '',
  })
  const agent = ctx.wetflow

  const industrialSettingsFile = options.industrialSettingsPath
    ?? process.env.WETFLOW_INDUSTRIAL_SETTINGS_FILE
    ?? '.wetflow/industrial-settings.json'
  const industrialDefaultDb = options.industrialDbPath
    ?? process.env.WETFLOW_INDUSTRIAL_DB
    ?? '.wetflow/industrial.db'
  const industrialDatabasePath = storedIndustrialDatabase(industrialSettingsFile) ?? industrialDefaultDb
  const industrialSettings = new IndustrialSettingsManager(industrialSettingsFile, industrialDatabasePath)
  // The industrial database is opened on first use so a workflow-only install
  // never creates it.
  let industrial: IndustrialStore | undefined
  const industrialStore = (): IndustrialStore => {
    industrial ??= new IndustrialStore(industrialDatabasePath)
    return industrial
  }
  openIndustrialStore = industrialStore

  const workflowRunIds = (): Set<string> => new Set(agent.store.workflowRuns().map(run => run.id))
  const resolveRunId = (candidate?: unknown): string => {
    const requested = typeof candidate === 'string' ? candidate.trim() : ''
    const runId = requested || agent.store.activeWorkflowRunId()
    if (!workflowRunIds().has(runId)) throw new Error('工作流运行不存在。')
    return runId
  }
  resolveIndustrialRunId = resolveRunId
  if (!agent.tools.has('industrial_parameter_list')) registerAgentTools(agent.tools)

  // Local numerical modeling shares the same run-scoped service as REST. The
  // service is opened lazily and the run resolver is the same one the industrial
  // tools use, so a task or prediction can never cross a workflow run boundary.
  const modelingDataDir = options.modelingDataDir ?? process.env.WETFLOW_MODELING_DIR ?? '.wetflow/modeling'
  let modeling: ModelingService | undefined
  const modelingService = (): ModelingService => {
    modeling ??= new ModelingService({
      dataDir: modelingDataDir,
      validateRunId: runId => { resolveRunId(runId) },
      createPrediction: (runId, input) => createModelingPrediction(industrialStore(), runId, input),
      linkPrediction: (runId, predictionId, experimentRef, note) => {
        const prediction = industrialStore().prediction(predictionId)
        if (!prediction || prediction.workflowRunId !== runId) throw new Error('预测不存在。')
        industrialStore().linkPredictionExperiment(predictionId, experimentRef, note, { id: 'wetflow-modeling-agent', role: 'application' })
      },
    })
    return modeling
  }
  if (!agent.tools.has('modeling_methods')) {
    registerModelingTools(agent.tools, () => modelingService(), candidate => resolveRunId(candidate))
  }
  const researchDbPath = options.researchDbPath ?? process.env.WETFLOW_RESEARCH_DB ?? (workflowDbPath === ':memory:' ? ':memory:' : join(dirname(workflowDbPath), 'research.db'))
  const researchStore = new ResearchStore(researchDbPath)
  researchService = new ResearchService({ store: researchStore, validateRunId: runId => { resolveRunId(runId) }, modeling: modelingService })
  if (!agent.tools.has('research_profile')) {
    registerResearchTools(agent.tools, () => { if (!researchService) throw new Error('研究服务尚未就绪。'); return researchService }, candidate => resolveRunId(candidate))
  }
  const industrialError = (reply: FastifyReply, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    const missing = message === '工作流运行不存在。' || message.endsWith('不存在。')
    return reply.code(missing ? 404 : 400).send({ error: message })
  }
  // Modeling lookups are run-scoped: an unknown run, task, dataset, or artifact is
  // a 404 rather than a 500, and every other rejected shape is a helpful 400.
  const modelingError = (reply: FastifyReply, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    const notFound = message === '工作流运行不存在。' || /不存在|not found|missing|no such|unavailable/i.test(message)
    return reply.code(notFound ? 404 : 400).send({ error: message })
  }

  app.get('/health', async () => ({ ok: true, framework: 'cordis', service: 'wetflow-agent' }))
  app.get('/api/snapshot', async () => agent.snapshot())
  app.get('/api/evidence', async () => ({ items: agent.store.evidenceSources() }))
  app.post<{ Body: { name?: string; content?: string; mimeType?: string } }>('/api/evidence', async (request, reply) => {
    try {
      return agent.store.addEvidenceSource(
        request.body.name ?? '', request.body.content ?? '', request.body.mimeType ?? 'text/plain',
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/workspace', async () => agent.store.workspace())
  app.post<{ Body: { name?: string } }>('/api/projects', async (request, reply) => {
    try {
      return agent.newProject(request.body.name ?? '')
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post<{ Body: { name?: string; projectId?: string } }>('/api/workflow-runs', async (request, reply) => {
    try {
      return agent.newWorkflowRun(request.body.name ?? '', request.body.projectId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(message === '项目不存在。' ? 404 : 400).send({ error: message })
    }
  })
  app.post<{ Params: { id: string } }>('/api/workflow-runs/:id/activate', async (request, reply) => {
    try {
      return agent.switchWorkflowRun(request.params.id)
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/conversations', async () => ({
    activeId: agent.store.activeConversationId(),
    items: agent.store.conversations(),
  }))
  app.post('/api/conversations', async () => agent.newConversation())
  app.post<{ Params: { id: string } }>('/api/conversations/:id/activate', async (request, reply) => {
    try {
      return agent.switchConversation(request.params.id)
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.patch<{ Params: { id: string }; Body: { title?: string } }>('/api/conversations/:id', async (request, reply) => {
    try {
      return agent.store.renameConversation(request.params.id, request.body.title ?? '')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(message === '对话不存在。' ? 404 : 400).send({ error: message })
    }
  })
  app.patch<{ Params: { id: string }; Body: { content?: string; model?: string; reasoningEffort?: ReasoningEffort } }>('/api/messages/:id', async (request, reply) => {
    try {
      const reasoningEffort = request.body.reasoningEffort
      if (reasoningEffort && !['low', 'medium', 'high'].includes(reasoningEffort)) {
        return reply.code(400).send({ error: 'reasoningEffort 必须是 low、medium 或 high。' })
      }
      const catalog = await agent.modelOptions()
      const model = request.body.model?.trim()
      if (catalog.enabled && model && !catalog.models.some(item => item.id === model)) {
        return reply.code(400).send({ error: '所选模型不在当前 Provider 的可用列表中。' })
      }
      return await agent.editMessage(request.params.id, request.body.content ?? '', {
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message.startsWith('消息不存在') ? 404 : message.includes('工作流状态已经发生变更') ? 409 : 400
      return reply.code(status).send({ error: message })
    }
  })
  app.get('/api/model-settings', async () => publicModelSettings(modelSettings))
  app.post<{ Body: { provider?: string; baseUrl?: string; apiKey?: string; model?: string } }>('/api/model-settings', async (request, reply) => {
    const provider = request.body.provider
    const baseUrl = request.body.baseUrl?.trim() ?? ''
    const apiKey = request.body.apiKey?.trim() || modelSettings?.apiKey || ''
    const model = request.body.model?.trim() ?? ''
    if (provider !== 'openai-compatible') return reply.code(400).send({ error: '目前仅支持 OpenAI Compatible 提供商。' })
    try {
      const url = new URL(baseUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
    } catch {
      return reply.code(400).send({ error: 'Base URL 必须是有效的 HTTP 或 HTTPS 地址。' })
    }
    if (!apiKey) return reply.code(400).send({ error: '请填写 API Key。' })
    if (!model) return reply.code(400).send({ error: '请填写模型 ID。' })
    modelSettings = { provider, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model }
    writeModelSettings(settingsPath, modelSettings)
    agent.setProvider(new OpenAICompatibleProvider({ baseUrl: modelSettings.baseUrl, apiKey, model }))
    return publicModelSettings(modelSettings)
  })
  app.get('/api/models', async () => {
    const catalog = await agent.modelOptions()
    return {
      ...catalog,
      reasoningEfforts: [
        { id: 'low', label: '低', description: '响应更快' },
        { id: 'medium', label: '中', description: '速度与推理平衡' },
        { id: 'high', label: '高', description: '更充分地推理' },
      ],
      defaultReasoningEffort: 'medium',
    }
  })
  app.post<{ Body: { content?: string; model?: string; reasoningEffort?: ReasoningEffort } }>('/api/chat', async (request, reply) => {
    try {
      const reasoningEffort = request.body.reasoningEffort
      if (reasoningEffort && !['low', 'medium', 'high'].includes(reasoningEffort)) {
        return reply.code(400).send({ error: 'reasoningEffort 必须是 low、medium 或 high。' })
      }
      const catalog = await agent.modelOptions()
      const model = request.body.model?.trim()
      if (catalog.enabled && model && !catalog.models.some(item => item.id === model)) {
        return reply.code(400).send({ error: '所选模型不在当前 Provider 的可用列表中。' })
      }
      return await agent.chat(request.body.content ?? '', {
        ...(catalog.enabled && model ? { model } : {}),
        ...(catalog.enabled && reasoningEffort ? { reasoningEffort } : {}),
      })
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post<{ Params: { id: string }; Body: { decision?: string } }>('/api/approvals/:id', async (request, reply) => {
    const decision = request.body.decision
    if (decision !== 'approve' && decision !== 'reject') return reply.code(400).send({ error: 'decision 必须是 approve 或 reject。' })
    try {
      return await agent.decide(request.params.id, decision)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/wake', async () => agent.wake())
  app.get('/api/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const send = (event: AgentEvent): void => { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`) }
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000)
    agent.events.on('event', send)
    request.raw.on('close', () => {
      clearInterval(keepAlive)
      agent.events.off('event', send)
    })
  })

  // Local numerical modeling is run-owned and uses the same service as native agent tools.
  const modelingBody = (body: unknown): Record<string, unknown> => (
    body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  )
  app.get('/api/modeling/methods', async () => modelingService().methods())
  app.get<{ Querystring: { runId?: string } }>('/api/modeling/datasets', async (request, reply) => {
    try { return { items: modelingService().listDatasets(resolveRunId(request.query.runId)) } }
    catch (error) { return modelingError(reply, error) }
  })
  app.post('/api/modeling/datasets', async (request, reply) => {
    try {
      const body = modelingBody(request.body)
      const runId = resolveRunId(body.runId)
      return reply.code(201).send(modelingService().createDataset(runId, { name: body.name as string, csv: body.csv as string }))
    } catch (error) { return modelingError(reply, error) }
  })
  app.get<{ Querystring: { runId?: string } }>('/api/modeling/tasks', async (request, reply) => {
    try { return { items: modelingService().list(resolveRunId(request.query.runId)) } }
    catch (error) { return modelingError(reply, error) }
  })
  app.post('/api/modeling/tasks', async (request, reply) => {
    try {
      const body = modelingBody(request.body)
      const runId = resolveRunId(body.runId)
      const budget = body.budget
      return reply.code(202).send(modelingService().submit(runId, {
        method: body.method as string,
        parameters: (body.parameters ?? {}) as Record<string, unknown>,
        ...(typeof body.datasetId === 'string' ? { datasetId: body.datasetId } : {}),
        ...(budget !== undefined && budget !== null ? { budget: budget as { wallTimeMs?: number; maxOutputRows?: number } } : {}),
        ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title } : {}),
      }))
    } catch (error) { return modelingError(reply, error) }
  })
  app.get<{ Params: { id: string }; Querystring: { runId?: string } }>('/api/modeling/tasks/:id', async (request, reply) => {
    try { return modelingService().get(resolveRunId(request.query.runId), request.params.id) }
    catch (error) { return modelingError(reply, error) }
  })
  app.post<{ Params: { id: string } }>('/api/modeling/tasks/:id/cancel', async (request, reply) => {
    try { return modelingService().cancel(resolveRunId(modelingBody(request.body).runId), request.params.id) }
    catch (error) { return modelingError(reply, error) }
  })
  app.get<{ Params: { id: string }; Querystring: { runId?: string } }>('/api/modeling/tasks/:id/result', async (request, reply) => {
    try { return modelingService().result(resolveRunId(request.query.runId), request.params.id) }
    catch (error) { return modelingError(reply, error) }
  })
  app.get<{ Params: { id: string; artifactId: string }; Querystring: { runId?: string } }>('/api/modeling/tasks/:id/artifacts/:artifactId', async (request, reply) => {
    try {
      const artifact = modelingService().artifact(resolveRunId(request.query.runId), request.params.id, request.params.artifactId)
      const fallbackName = artifact.name.replace(/[^\w.-]/g, '_')
      reply.header('content-disposition', `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`)
      return reply.type(artifact.mediaType).send(createReadStream(artifact.path))
    } catch (error) { return modelingError(reply, error) }
  })
  app.post<{ Params: { id: string } }>('/api/modeling/tasks/:id/prediction', async (request, reply) => {
    try {
      const body = modelingBody(request.body)
      return modelingService().registerPrediction(resolveRunId(body.runId), request.params.id, {
        prediction: body.prediction as string,
        ...(body.conditions !== undefined ? { conditions: body.conditions as string } : {}),
        ...(body.uncertainty !== undefined ? { uncertainty: body.uncertainty as string } : {}),
        ...(body.linkedExperiment !== undefined ? { linkedExperiment: body.linkedExperiment as string } : {}),
      })
    } catch (error) { return modelingError(reply, error) }
  })
  app.post<{ Params: { id: string } }>('/api/modeling/tasks/:id/experiment', async (request, reply) => {
    try {
      const body = modelingBody(request.body)
      return modelingService().linkExperiment(resolveRunId(body.runId), request.params.id, {
        experimentRef: body.experimentRef as string,
        ...(body.note !== undefined ? { note: body.note as string } : {}),
      })
    } catch (error) { return modelingError(reply, error) }
  })

  registerResearchRoutes(app, researchService, candidate => resolveRunId(candidate))

  // Industrial records live next to the workflow database and stop at an
  // approval boundary: no endpoint dispatches anything to an external system.
  app.get('/api/industrial/settings', async () => ({ settings: industrialSettings.public() }))
  app.patch<{ Body: Partial<IndustrialSettings> }>('/api/industrial/settings', async (request, reply) => {
    try {
      return { settings: industrialSettings.update(request.body ?? {}) }
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.get<{ Querystring: { runId?: string } }>('/api/industrial/overview', async (request, reply) => {
    try {
      const runId = resolveRunId(request.query.runId)
      return industrialStore().overview(runId)
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.get<{ Querystring: { runId?: string } }>('/api/industrial/profile', async (request, reply) => {
    try {
      const runId = resolveRunId(request.query.runId)
      return { runId, profile: industrialStore().profile(runId) ?? null }
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.put<{ Body: BatchProfileInput & { runId?: string } }>('/api/industrial/profile', async (request, reply) => {
    try {
      const runId = resolveRunId(request.body?.runId)
      return industrialStore().saveProfile(runId, request.body ?? {}, actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.get<{ Querystring: { runId?: string } }>('/api/industrial/entities', async (request, reply) => {
    try {
      const runId = resolveRunId(request.query.runId)
      return { runId, items: industrialStore().entities(runId) }
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.post<{ Body: EntityInput & { runId?: string } }>('/api/industrial/entities', async (request, reply) => {
    try {
      const runId = resolveRunId(request.body?.runId)
      return industrialStore().addEntity(runId, request.body ?? {}, actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.get<{ Querystring: { runId?: string } }>('/api/industrial/lots', async (request, reply) => {
    try {
      const runId = resolveRunId(request.query.runId)
      return { runId, items: industrialStore().lots(runId) }
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.post<{ Body: LotInput & { runId?: string } }>('/api/industrial/lots', async (request, reply) => {
    try {
      const runId = resolveRunId(request.body?.runId)
      return industrialStore().addLot(runId, request.body ?? {}, actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.get<{ Querystring: { runId?: string } }>('/api/industrial/genealogy', async (request, reply) => {
    try {
      const runId = resolveRunId(request.query.runId)
      return { runId, items: industrialStore().genealogy(runId) }
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.post<{ Body: GenealogyInput & { runId?: string } }>('/api/industrial/genealogy', async (request, reply) => {
    try {
      const runId = resolveRunId(request.body?.runId)
      return industrialStore().addGenealogyLink(runId, request.body ?? {}, actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.get<{ Querystring: { runId?: string } }>('/api/industrial/parameters', async (request, reply) => {
    try {
      const runId = resolveRunId(request.query.runId)
      return { runId, items: industrialStore().parameters(runId) }
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.post<{ Body: ParameterInput & { runId?: string } }>('/api/industrial/parameters', async (request, reply) => {
    try {
      const runId = resolveRunId(request.body?.runId)
      return industrialStore().saveParameter(runId, request.body ?? {}, actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.get<{ Querystring: { runId?: string; limit?: string } }>('/api/industrial/telemetry', async (request, reply) => {
    try {
      const runId = resolveRunId(request.query.runId)
      const limit = request.query.limit ? Number(request.query.limit) : undefined
      return { runId, items: industrialStore().telemetry(runId, limit && Number.isFinite(limit) ? limit : 50) }
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.post<{ Body: TelemetryInput & { runId?: string } }>('/api/industrial/telemetry', async (request, reply) => {
    try {
      const runId = resolveRunId(request.body?.runId)
      return industrialStore().recordTelemetry(runId, request.body ?? {}, actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.get<{ Querystring: { runId?: string; status?: string } }>('/api/industrial/deviations', async (request, reply) => {
    try {
      const runId = resolveRunId(request.query.runId)
      const status = request.query.status as DeviationStatus | undefined
      return { runId, items: industrialStore().deviations(runId, status) }
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.post<{ Body: DeviationInput & { runId?: string } }>('/api/industrial/deviations', async (request, reply) => {
    try {
      const runId = resolveRunId(request.body?.runId)
      return industrialStore().addDeviation(runId, request.body ?? {}, actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.patch<{ Params: { id: string }; Body: DeviationResolutionInput }>('/api/industrial/deviations/:id', async (request, reply) => {
    try {
      return industrialStore().resolveDeviation(request.params.id, request.body ?? {}, actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.get<{ Querystring: { runId?: string } }>('/api/industrial/connectors', async (request, reply) => {
    try {
      const runId = resolveRunId(request.query.runId)
      return { runId, items: industrialStore().connectors(runId) }
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.post<{ Body: ConnectorInput & { runId?: string } }>('/api/industrial/connectors', async (request, reply) => {
    try {
      const runId = resolveRunId(request.body?.runId)
      return industrialStore().saveConnector(runId, request.body ?? {}, actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.get<{ Querystring: { runId?: string } }>('/api/industrial/actions', async (request, reply) => {
    try {
      const runId = resolveRunId(request.query.runId)
      return { runId, items: industrialStore().actions(runId) }
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.post<{ Body: ActionInput & { runId?: string } }>('/api/industrial/actions', async (request, reply) => {
    try {
      const runId = resolveRunId(request.body?.runId)
      return industrialStore().proposeAction(runId, request.body ?? {}, actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.post<{ Params: { id: string }; Body: { decision?: string; comment?: string } }>('/api/industrial/actions/:id/decisions', async (request, reply) => {
    const decision = request.body?.decision?.toUpperCase()
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      return reply.code(400).send({ error: 'decision 必须是 APPROVE 或 REJECT。' })
    }
    try {
      return industrialStore().decideAction(request.params.id, decision, request.body?.comment ?? '', actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.get<{ Querystring: { runId?: string } }>('/api/industrial/predictions', async (request, reply) => {
    try {
      const runId = resolveRunId(request.query.runId)
      return { runId, items: industrialStore().predictions(runId) }
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.post<{ Body: PredictionInput & { runId?: string } }>('/api/industrial/predictions', async (request, reply) => {
    try {
      const runId = resolveRunId(request.body?.runId)
      return industrialStore().addPrediction(runId, request.body ?? {}, actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.patch<{ Params: { id: string }; Body: { status?: string; note?: string } }>('/api/industrial/predictions/:id', async (request, reply) => {
    const status = request.body?.status?.toUpperCase()
    if (status !== 'TESTED' && status !== 'CONFIRMED' && status !== 'REFUTED' && status !== 'WITHDRAWN') {
      return reply.code(400).send({ error: 'status 必须是 TESTED、CONFIRMED、REFUTED 或 WITHDRAWN。' })
    }
    try {
      return industrialStore().updatePredictionStatus(request.params.id, status, request.body?.note ?? '', actorFrom(request.headers))
    } catch (error) {
      return industrialError(reply, error)
    }
  })
  app.get<{ Querystring: { runId?: string; limit?: string } }>('/api/industrial/audit', async (request, reply) => {
    try {
      const runId = resolveRunId(request.query.runId)
      const limit = request.query.limit ? Number(request.query.limit) : undefined
      return {
        runId,
        chain: industrialStore().auditChain(runId),
        items: industrialStore().audit({ workflowRunId: runId, ...(limit && Number.isFinite(limit) ? { limit } : {}) }),
      }
    } catch (error) {
      return industrialError(reply, error)
    }
  })

  if (options.serveWeb !== false) {
    const here = dirname(fileURLToPath(import.meta.url))
    const builtWebRoot = join(here, '../web')
    const sourceWebRoot = join(process.cwd(), 'dist/web')
    const webRoot = existsSync(join(builtWebRoot, 'index.html')) ? builtWebRoot : sourceWebRoot
    if (existsSync(webRoot)) {
      await app.register(fastifyStatic, { root: webRoot })
      app.setNotFoundHandler(async (request, reply) => {
        if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
          return reply.sendFile('index.html')
        }
        return reply.code(404).send({ error: 'Not found' })
      })
    }
  }

  app.addHook('onClose', async () => {
    await modeling?.close()
    await researchService?.close()
    researchStore.close()
    industrial?.close()
    await ctx.fiber.dispose()
  })
  return app
}

export async function startServer(options: ServerOptions = {}): Promise<void> {
  const app = await createServer(options)
  const host = options.host ?? process.env.WETFLOW_HOST ?? '127.0.0.1'
  const port = options.port ?? Number(process.env.WETFLOW_PORT ?? 4310)
  await app.listen({ host, port })
  console.log(`WetFlow WebUI: http://${host}:${port}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer()
}
