#!/usr/bin/env node
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import type { FastifyReply } from 'fastify'
import fastifyStatic from '@fastify/static'
import { createWetFlowContext } from './cordis.js'
import { createWetFlowPlugins, PLUGIN_IDS, type PluginId } from './plugins/index.js'
import type { AgentEvent } from './core/types.js'
import type { ReasoningEffort } from './agent/provider.js'
import { OpenAICompatibleProvider } from './agent/provider.js'
import { DEFAULT_CONTEXT_TOKEN_BUDGET, isContextTokenBudget } from './agent/context-budget.js'
import { GENERIC_REASONING, isReasoningEffort } from './agent/reasoning.js'
import { registerResearchRoutes } from './research/routes.js'
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
  privacySettingsPath?: string
  contextTokenBudget?: number
  industrialSettingsPath?: string
  industrialDbPath?: string
  modelingDataDir?: string
  researchDbPath?: string
  plugins?: PluginId[]
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

function readDocumentExcerptConsent(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { allowDocumentExcerpts?: unknown }
    return parsed.allowDocumentExcerpts === true
  } catch {
    return false
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
  const privacySettingsPath = options.privacySettingsPath ?? join(dirname(settingsPath), 'privacy-settings.json')
  let allowDocumentExcerpts = readDocumentExcerptConsent(privacySettingsPath)
  let modelSettings = readModelSettings(settingsPath)
  if (!modelSettings) {
    const baseUrl = process.env.WETFLOW_MODEL_BASE_URL?.trim() ?? ''
    const apiKey = process.env.WETFLOW_MODEL_API_KEY?.trim() ?? ''
    const model = process.env.WETFLOW_MODEL?.trim() ?? ''
    if (baseUrl && apiKey && model) modelSettings = { provider: 'openai-compatible', baseUrl, apiKey, model }
  }
  const contextSettingsPath = join(dirname(settingsPath), 'context-settings.json')
  let savedContextBudget: number | undefined
  try {
    const saved = JSON.parse(readFileSync(contextSettingsPath, 'utf8')) as { tokenBudget?: unknown }
    if (isContextTokenBudget(saved.tokenBudget)) savedContextBudget = saved.tokenBudget
  } catch { /* First run or invalid saved settings: use the configured default. */ }
  const contextTokenBudget = options.contextTokenBudget ?? savedContextBudget ?? (process.env.WETFLOW_CONTEXT_TOKEN_BUDGET
    ? Number(process.env.WETFLOW_CONTEXT_TOKEN_BUDGET)
    : DEFAULT_CONTEXT_TOKEN_BUDGET)
  const workflowDbPath = options.dbPath ?? process.env.WETFLOW_DB ?? '.wetflow/wetflow-agent.db'
  const ctx = await createWetFlowContext({
    dbPath: workflowDbPath,
    modelBaseUrl: modelSettings?.baseUrl ?? '',
    modelApiKey: modelSettings?.apiKey ?? '',
    model: modelSettings?.model ?? '',
    models: (process.env.WETFLOW_MODELS ?? '').split(',').map(value => value.trim()).filter(Boolean),
    ...(contextTokenBudget ? { contextTokenBudget } : {}),
    additionalContext: runId => ctx.wetflowResearch?.context(runId) ?? '',
    allowDocumentExcerpts: () => allowDocumentExcerpts,
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
  const industrialStore = (): IndustrialStore => {
    if (!ctx.wetflowExperiment) throw new Error('Experiment Plugin is unloaded')
    return ctx.wetflowExperiment.store()
  }

  const workflowRunIds = (): Set<string> => new Set(agent.store.workflowRuns().map(run => run.id))
  const resolveRunId = (candidate?: unknown): string => {
    const requested = typeof candidate === 'string' ? candidate.trim() : ''
    const runId = requested || agent.store.activeWorkflowRunId()
    if (!workflowRunIds().has(runId)) throw new Error('工作流运行不存在。')
    return runId
  }
  const modelingService = () => {
    if (!ctx.wetflowModeling) throw new Error('Modeling Plugin is unloaded')
    return ctx.wetflowModeling
  }
  const researchService = () => {
    if (!ctx.wetflowResearch) throw new Error('Research Plugin is unloaded')
    return ctx.wetflowResearch
  }
  const plugins = await createWetFlowPlugins(ctx, {
    experiment: { dbPath: industrialDatabasePath },
    modeling: {
      dataDir: options.modelingDataDir ?? process.env.WETFLOW_MODELING_DIR ?? '.wetflow/modeling',
      createPrediction: (runId, input) => createModelingPrediction(industrialStore(), runId, input),
      linkPrediction: (runId, predictionId, experimentRef, note) => {
        const prediction = industrialStore().prediction(predictionId)
        if (!prediction || prediction.workflowRunId !== runId) throw new Error('预测不存在。')
        industrialStore().linkPredictionExperiment(predictionId, experimentRef, note, { id: 'wetflow-modeling-agent', role: 'application' })
      },
    },
    research: {
      dbPath: options.researchDbPath ?? process.env.WETFLOW_RESEARCH_DB ?? (workflowDbPath === ':memory:' ? ':memory:' : join(dirname(workflowDbPath), 'research.db')),
      modeling: modelingService,
    },
  })
  try {
    for (const id of options.plugins ?? PLUGIN_IDS) await plugins.load(id)
  } catch (error) { await ctx.fiber.dispose(); throw error }

  // Routes resolve services on each request; unloading cannot leave a live REST backdoor.
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? ''
    const id = path.startsWith('/api/modeling/') ? 'modeling'
      : path.startsWith('/api/research/') ? 'research'
      : path.startsWith('/api/industrial/') ? 'experiment'
      : path === '/api/evidence' ? 'evidence' : undefined
    if (id && !plugins.snapshot().plugins.find(plugin => plugin.id === id)?.loaded) {
      return reply.code(503).send({ error: `${id} Plugin is unloaded`, plugin: id })
    }
  })
  app.get('/api/plugins', async () => plugins.snapshot())
  app.post<{ Params: { id: string; action: string } }>('/api/plugins/:id/:action', async (request, reply) => {
    const { id, action } = request.params
    if (!PLUGIN_IDS.includes(id as PluginId) || !['load', 'unload'].includes(action)) return reply.code(404).send({ error: 'Unknown plugin or action' })
    if (agent.snapshot().agentState === 'THINKING') return reply.code(409).send({ error: 'Wait for the current Agent turn to finish' })
    try {
      const result = await plugins[action as 'load' | 'unload'](id as PluginId)
      agent.events.emit('event', { type: 'snapshot', snapshot: agent.snapshot() })
      return result
    }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }) }
  })
  app.get('/api/plugins/modeling-probe', async (_request, reply) => {
    try {
      return { tool: 'modeling_methods', result: await agent.tools.get('modeling_methods').execute({}) }
    } catch (error) { return reply.code(409).send({ tool: 'modeling_methods', available: false, error: error instanceof Error ? error.message : String(error) }) }
  })
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
  app.get('/api/evidence', async () => ({ items: ctx.wetflowEvidence!.sources() }))
  app.post<{ Body: { name?: string; content?: string; mimeType?: string } }>('/api/evidence', async (request, reply) => {
    try {
      return ctx.wetflowEvidence!.add(
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
      if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) {
        return reply.code(400).send({ error: 'reasoningEffort 必须是 off、low、medium、high 或 max。' })
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
  app.patch<{ Body: { tokenBudget?: unknown } }>('/api/context-settings', async (request, reply) => {
    const budget = request.body?.tokenBudget
    if (!isContextTokenBudget(budget)) return reply.code(400).send({ error: '上下文预算须为 1,024 至 1,000,000 之间的整数。' })
    if (agent.snapshot().agentState === 'THINKING') return reply.code(409).send({ error: '请等待当前回复完成后再调整上下文预算。' })
    mkdirSync(dirname(contextSettingsPath), { recursive: true })
    writeFileSync(contextSettingsPath, `${JSON.stringify({ tokenBudget: budget }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    agent.setContextTokenBudget(budget)
    return agent.snapshot()
  })
  app.get('/api/privacy-settings', async () => ({ allowDocumentExcerpts }))
  app.patch<{ Body: { allowDocumentExcerpts?: boolean } }>('/api/privacy-settings', async (request, reply) => {
    if (typeof request.body?.allowDocumentExcerpts !== 'boolean') return reply.code(400).send({ error: 'allowDocumentExcerpts 必须是布尔值。' })
    allowDocumentExcerpts = request.body.allowDocumentExcerpts
    mkdirSync(dirname(privacySettingsPath), { recursive: true })
    writeFileSync(privacySettingsPath, `${JSON.stringify({ allowDocumentExcerpts }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(privacySettingsPath, 0o600) } catch { /* Windows may ignore POSIX modes. */ }
    return { allowDocumentExcerpts }
  })
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
    const reasoning = catalog.models.find(item => item.id === catalog.defaultModel)?.reasoning ?? GENERIC_REASONING
    return {
      ...catalog,
      reasoningEfforts: reasoning.efforts,
      defaultReasoningEffort: reasoning.defaultEffort,
    }
  })
  app.post<{ Body: { content?: string; model?: string; reasoningEffort?: ReasoningEffort } }>('/api/chat', async (request, reply) => {
    try {
      const reasoningEffort = request.body.reasoningEffort
      if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) {
        return reply.code(400).send({ error: 'reasoningEffort 必须是 off、low、medium、high 或 max。' })
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
    await plugins.close()
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
