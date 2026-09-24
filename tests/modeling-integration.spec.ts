import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WetFlowAgent } from '../src/agent/runtime.js'
import { registerModelingTools } from '../src/agent/modeling-tools.js'
import type { ModelContextFrame } from '../src/agent/context.js'
import type {
  ModelProvider,
  ModelRequestOptions,
  ModelSession,
  ModelTurn,
} from '../src/agent/provider.js'
import type { ToolRegistry } from '../src/agent/tools.js'
import { WetFlowStore } from '../src/core/store.js'
import { ModelingService } from '../src/modeling/service.js'
import { IndustrialStore } from '../src/industrial/index.js'
import { createServer, type ServerOptions } from '../src/server.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const modelingServerOptions = (dir: string): ServerOptions => ({
  dbPath: join(dir, 'workflow.db'),
  industrialDbPath: join(dir, 'industrial.db'),
  industrialSettingsPath: join(dir, 'industrial-settings.json'),
  settingsPath: join(dir, 'model-settings.json'),
  modelingDataDir: join(dir, 'modeling'),
  serveWeb: false,
})

type App = Awaited<ReturnType<typeof createServer>>

async function waitForHttpTask(app: App, runId: string, taskId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000
  let task = (await app.inject({ method: 'GET', url: `/api/modeling/tasks/${taskId}?runId=${runId}` })).json() as Record<string, unknown>
  while (task.status === 'QUEUED' || task.status === 'RUNNING') {
    if (Date.now() > deadline) throw new Error('HTTP modeling task did not finish')
    await sleep(25)
    task = (await app.inject({ method: 'GET', url: `/api/modeling/tasks/${taskId}?runId=${runId}` })).json() as Record<string, unknown>
  }
  return task
}

describe('modeling REST integration', () => {
  it('runs method discovery, real worker success, artifact streaming, prediction registration, and experiment association', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-rest-')); dirs.push(dir)
    const app = await createServer(modelingServerOptions(dir))
    try {
      const workspace = (await app.inject({ method: 'GET', url: '/api/workspace' })).json()
      const runId = workspace.activeWorkflowRunId as string

      const methods = (await app.inject({ method: 'GET', url: '/api/modeling/methods' })).json()
      expect(methods.items.map((item: { id: string }) => item.id)).toEqual(['monod_batch', 'growth_fit'])
      expect(methods.items.every((item: { version?: string; units?: unknown }) => typeof item.version === 'string' && item.units)).toBe(true)

      const datasetResponse = await app.inject({
        method: 'POST', url: '/api/modeling/datasets',
        payload: { runId, name: 'growth.csv', csv: 'time,biomass\n0,0.1\n1,0.2\n2,0.4\n3,0.8\n' },
      })
      expect(datasetResponse.statusCode).toBe(201)
      const datasetId = datasetResponse.json().id as string

      const taskResponse = await app.inject({
        method: 'POST', url: '/api/modeling/tasks',
        payload: { runId, method: 'growth_fit', parameters: {}, datasetId, title: 'rest chain' },
      })
      expect(taskResponse.statusCode).toBe(202)
      const taskId = taskResponse.json().id as string
      const task = await waitForHttpTask(app, runId, taskId)
      expect(task.status).toBe('SUCCEEDED')
      expect(task.methodVersion).toBeTruthy()

      const resultResponse = await app.inject({ method: 'GET', url: `/api/modeling/tasks/${taskId}/result?runId=${runId}` })
      expect(resultResponse.statusCode).toBe(200)
      const result = resultResponse.json()
      expect(result.metrics.growthRate).toBeCloseTo(Math.log(2), 4)
      expect(result.methodVersion).toBe(task.methodVersion)
      expect(result.artifacts.map((artifact: { id: string }) => artifact.id).sort()).toEqual(['result', 'trajectory'])

      const jsonArtifact = await app.inject({ method: 'GET', url: `/api/modeling/tasks/${taskId}/artifacts/result?runId=${runId}` })
      expect(jsonArtifact.statusCode).toBe(200)
      expect(String(jsonArtifact.headers['content-type'])).toContain('application/json')
      expect(String(jsonArtifact.headers['content-disposition'])).toContain('result.json')
      expect(jsonArtifact.json().methodVersion).toBe(result.methodVersion)

      const csvArtifact = await app.inject({ method: 'GET', url: `/api/modeling/tasks/${taskId}/artifacts/trajectory?runId=${runId}` })
      expect(csvArtifact.statusCode).toBe(200)
      expect(String(csvArtifact.headers['content-type'])).toContain('text/csv')
      expect(String(csvArtifact.headers['content-disposition'])).toContain('output.csv')
      expect(csvArtifact.body).toContain('fitted_biomass_g_L')

      // Prediction shape is validated: an empty prediction is a 400, not a 500.
      expect((await app.inject({ method: 'POST', url: `/api/modeling/tasks/${taskId}/prediction`, payload: { runId, prediction: '' } })).statusCode).toBe(400)
      // Experiment linking requires a registered prediction first.
      expect((await app.inject({ method: 'POST', url: `/api/modeling/tasks/${taskId}/experiment`, payload: { runId, experimentRef: 'ELN-EARLY' } })).statusCode).toBe(400)

      const registered = await app.inject({
        method: 'POST', url: `/api/modeling/tasks/${taskId}/prediction`,
        payload: { runId, prediction: 'Estimated growth rate is 0.693 1/h', uncertainty: 'Diagnostics only, not a confidence interval.' },
      })
      expect(registered.statusCode).toBe(200)
      const predictionId = registered.json().predictionId as string
      const registeredAgain = await app.inject({
        method: 'POST', url: `/api/modeling/tasks/${taskId}/prediction`,
        payload: { runId, prediction: 'Estimated growth rate is 0.693 1/h' },
      })
      expect(registeredAgain.json().predictionId).toBe(predictionId)

      const linked = await app.inject({
        method: 'POST', url: `/api/modeling/tasks/${taskId}/experiment`,
        payload: { runId, experimentRef: 'ELN-GROWTH-9', note: 'planned follow-up measurement' },
      })
      expect(linked.statusCode).toBe(200)
      expect(linked.json().linkedExperiment).toBe('ELN-GROWTH-9')
      expect(linked.json().linkedExperimentNote).toBe('planned follow-up measurement')

      const predictions = (await app.inject({ method: 'GET', url: `/api/industrial/predictions?runId=${runId}` })).json()
      const stored = predictions.items.find((item: { id: string }) => item.id === predictionId)
      expect(stored).toMatchObject({ status: 'PROPOSED', linkedExperiment: 'ELN-GROWTH-9' })
      expect(stored.artifactRef).toContain(`/api/modeling/tasks/${taskId}/artifacts/result`)

      // Cross-run isolation: another real run cannot read this run's task, result, artifact, or prediction.
      const secondRun = (await app.inject({ method: 'POST', url: '/api/workflow-runs', payload: { name: '第二运行' } })).json()
      const otherRunId = secondRun.workflow.id as string
      expect(otherRunId).not.toBe(runId)
      expect((await app.inject({ method: 'GET', url: `/api/modeling/tasks/${taskId}?runId=${otherRunId}` })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: `/api/modeling/tasks/${taskId}/result?runId=${otherRunId}` })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: `/api/modeling/tasks/${taskId}/artifacts/trajectory?runId=${otherRunId}` })).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: `/api/modeling/tasks/${taskId}/prediction`, payload: { runId: otherRunId, prediction: 'cross-run claim' } })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: `/api/modeling/tasks?runId=${otherRunId}` })).json().items).toEqual([])
      // The active run is now the second one, so an implicit read is also isolated.
      expect((await app.inject({ method: 'GET', url: `/api/modeling/tasks/${taskId}` })).statusCode).toBe(404)
    } finally { await app.close() }
  })

  it('answers malformed or missing modeling input with 4xx instead of 500', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-invalid-')); dirs.push(dir)
    const app = await createServer(modelingServerOptions(dir))
    try {
      const validParameters = { initialBiomass: 0.1, initialSubstrate: 2, muMax: 0.4, halfSaturation: 0.1, yield: 0.5, duration: 1, timeStep: 0.1 }
      const cases: Array<{ url: string; payload?: Record<string, unknown>; expected: number }> = [
        { url: '/api/modeling/tasks', payload: {}, expected: 400 },
        { url: '/api/modeling/tasks', payload: { method: 'monod_batch', parameters: {} }, expected: 400 },
        { url: '/api/modeling/tasks', payload: { method: 'monod_batch', parameters: null }, expected: 400 },
        { url: '/api/modeling/tasks', payload: { method: 'not_a_method', parameters: {} }, expected: 400 },
        { url: '/api/modeling/tasks', payload: { method: 'monod_batch', parameters: validParameters, budget: 'huge' }, expected: 400 },
        { url: '/api/modeling/tasks', payload: { method: 'monod_batch', parameters: validParameters, budget: { wallTimeMs: 5 } }, expected: 400 },
        { url: '/api/modeling/datasets', payload: {}, expected: 400 },
        { url: '/api/modeling/datasets', payload: { name: 'empty.csv', csv: '' }, expected: 400 },
        { url: '/api/modeling/datasets', payload: { name: 'bad.csv', csv: 'time,biomass\n0,\n1,2\n' }, expected: 400 },
        { url: '/api/modeling/tasks', payload: { method: 'growth_fit', parameters: {}, datasetId: 'missing-dataset' }, expected: 404 },
        { url: '/api/modeling/tasks?runId=ghost-run', expected: 404 },
        { url: '/api/modeling/datasets?runId=ghost-run', expected: 404 },
        { url: '/api/modeling/tasks/does-not-exist', expected: 404 },
        { url: '/api/modeling/tasks/does-not-exist/result', expected: 404 },
        { url: '/api/modeling/tasks/does-not-exist/artifacts/trajectory', expected: 404 },
      ]
      for (const item of cases) {
        const chain = item.payload === undefined
          ? app.inject({ method: 'GET', url: item.url })
          : app.inject({ method: 'POST', url: item.url, payload: item.payload })
        const response = await chain
        expect(response.statusCode, `${item.url} -> ${response.body}`).toBe(item.expected)
      }

      const noBody = await app.inject({ method: 'POST', url: '/api/modeling/tasks' })
      expect(noBody.statusCode).toBe(400)
      const noBodyDataset = await app.inject({ method: 'POST', url: '/api/modeling/datasets' })
      expect(noBodyDataset.statusCode).toBe(400)
      const badJson = await app.inject({
        method: 'POST', url: '/api/modeling/tasks',
        payload: '{not valid json', headers: { 'content-type': 'application/json' },
      })
      expect(badJson.statusCode).toBe(400)
      const ghostCancel = await app.inject({ method: 'POST', url: '/api/modeling/tasks/does-not-exist/cancel', payload: {} })
      expect(ghostCancel.statusCode).toBe(404)
    } finally { await app.close() }
  })

  it('persists tasks, results, predictions, and experiment links across a server restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-restart-')); dirs.push(dir)
    const options = modelingServerOptions(dir)
    let app = await createServer(options)
    let runId = ''
    let taskId = ''
    let predictionId = ''
    try {
      runId = (await app.inject({ method: 'GET', url: '/api/workspace' })).json().activeWorkflowRunId as string
      const dataset = await app.inject({
        method: 'POST', url: '/api/modeling/datasets',
        payload: { runId, name: 'restart.csv', csv: 'time,biomass\n0,1\n1,2\n2,4\n3,8\n' },
      })
      taskId = (await app.inject({
        method: 'POST', url: '/api/modeling/tasks',
        payload: { runId, method: 'growth_fit', parameters: {}, datasetId: dataset.json().id },
      })).json().id as string
      await waitForHttpTask(app, runId, taskId)
      predictionId = (await app.inject({
        method: 'POST', url: `/api/modeling/tasks/${taskId}/prediction`,
        payload: { runId, prediction: 'Restart-safe growth rate estimate' },
      })).json().predictionId as string
      await app.inject({
        method: 'POST', url: `/api/modeling/tasks/${taskId}/experiment`,
        payload: { runId, experimentRef: 'ELN-RESTART-1' },
      })
    } finally { await app.close() }

    app = await createServer(options)
    try {
      const restored = (await app.inject({ method: 'GET', url: `/api/modeling/tasks/${taskId}?runId=${runId}` })).json()
      expect(restored).toMatchObject({ status: 'SUCCEEDED', predictionId, linkedExperiment: 'ELN-RESTART-1' })
      const result = (await app.inject({ method: 'GET', url: `/api/modeling/tasks/${taskId}/result?runId=${runId}` })).json()
      expect(result.metrics.growthRate).toBeCloseTo(Math.log(2), 4)
      const predictions = (await app.inject({ method: 'GET', url: `/api/industrial/predictions?runId=${runId}` })).json()
      expect(predictions.items.find((item: { id: string }) => item.id === predictionId)).toMatchObject({
        status: 'PROPOSED', linkedExperiment: 'ELN-RESTART-1',
      })
      const jsonArtifact = await app.inject({ method: 'GET', url: `/api/modeling/tasks/${taskId}/artifacts/result?runId=${runId}` })
      expect(jsonArtifact.statusCode).toBe(200)
    } finally { await app.close() }
  })
})

// ---------------------------------------------------------------- agent E2E

type Script = (turn: number, context: ModelContextFrame, session: ModelSession | undefined) => ModelTurn | Promise<ModelTurn>

class ScriptedProvider implements ModelProvider {
  calls = 0
  readonly contexts: ModelContextFrame[] = []
  readonly sessions: Array<ModelSession | undefined> = []
  constructor(private readonly script: Script) {}
  async complete(context: ModelContextFrame, _tools: ToolRegistry, _options?: ModelRequestOptions, session?: ModelSession): Promise<ModelTurn> {
    this.calls += 1
    this.contexts.push(context)
    this.sessions.push(session ? structuredClone(session) : undefined)
    return await this.script(this.calls, context, session)
  }
  models() { return Promise.resolve([{ id: 'fake', label: 'Fake' }]) }
  defaultModel() { return 'fake' }
}

function parseTool(session: ModelSession | undefined, name: string): Record<string, unknown> {
  const message = [...(session?.messages ?? [])].reverse().find(item => item.role === 'tool' && item.name === name)
  if (!message || message.role !== 'tool') return {}
  try { return JSON.parse(message.content) as Record<string, unknown> } catch { return {} }
}

describe('agent modeling chain with real worker and database', () => {
  it('discovers methods, runs a real job, registers a real prediction, links an experiment, and survives restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-agent-e2e-')); dirs.push(dir)
    const store = new WetFlowStore(join(dir, 'workflow.db'))
    const runId = store.workflow().id
    const industrial = new IndustrialStore(join(dir, 'industrial.db'))
    const service = new ModelingService({
      dataDir: join(dir, 'modeling'),
      validateRunId: id => { if (id !== runId) throw new Error('工作流运行不存在。') },
      createPrediction: (predictionRunId, input) => industrial.addPrediction(predictionRunId, {
        model: String(input.model ?? 'local-modeling'), artifactRef: input.artifactRef,
        prediction: input.prediction, conditions: input.conditions, uncertainty: input.uncertainty,
        reason: input.reason,
      }, { id: 'wetflow-modeling-agent', role: 'application' }),
      linkPrediction: (predictionRunId, predictionId, experimentRef, note) => {
        const prediction = industrial.prediction(predictionId)
        if (!prediction || prediction.workflowRunId !== predictionRunId) throw new Error('预测不存在。')
        industrial.linkPredictionExperiment(predictionId, experimentRef, note, { id: 'wetflow-modeling-agent', role: 'application' })
      },
    })

    const script: Script = async (turn, _context, session) => {
      if (turn === 1) return { content: '查看方法。', toolCall: { id: 'c1', name: 'modeling_methods', arguments: {} } }
      if (turn === 2) {
        return {
          content: '提交 Monod 模拟。',
          toolCall: {
            id: 'c2', name: 'modeling_submit',
            arguments: {
              method: 'monod_batch',
              parameters: { initialBiomass: 0.1, initialSubstrate: 2, muMax: 0.4, halfSaturation: 0.1, yield: 0.5, duration: 1, timeStep: 0.1 },
              title: 'agent e2e',
            },
          },
        }
      }
      const taskId = String(parseTool(session, 'modeling_submit').id ?? '')
      expect(taskId).not.toBe('')
      if (turn === 3) {
        // The computation itself is asynchronous; wait on the real service, not on the model loop.
        for (let attempt = 0; attempt < 200 && service.get(runId, taskId).status !== 'SUCCEEDED'; attempt += 1) await sleep(25)
        return { content: '查询状态。', toolCall: { id: 'c3', name: 'modeling_status', arguments: { taskId } } }
      }
      if (turn === 4) {
        expect(parseTool(session, 'modeling_status').status).toBe('SUCCEEDED')
        return { content: '读取结果。', toolCall: { id: 'c4', name: 'modeling_result', arguments: { taskId } } }
      }
      if (turn === 5) {
        expect(parseTool(session, 'modeling_result').taskId).toBe(taskId)
        return { content: '登记预测。', toolCall: { id: 'c5', name: 'modeling_register_prediction', arguments: { taskId, prediction: 'Monod predicts a final biomass near 0.11 g/L' } } }
      }
      if (turn === 6) {
        const predictionId = parseTool(session, 'modeling_register_prediction').predictionId
        expect(typeof predictionId).toBe('string')
        return { content: '关联实验。', toolCall: { id: 'c6', name: 'modeling_link_experiment', arguments: { taskId, experimentRef: 'ELN-E2E-1', note: 'planned follow-up' } } }
      }
      return { content: `任务 ${taskId} 计算成功；预测已登记并关联 ELN-E2E-1（关联不代表已验证）。` }
    }

    const provider = new ScriptedProvider(script)
    const agent = new WetFlowAgent(store, provider)
    registerModelingTools(agent.tools, () => service, candidate => {
      if (candidate === undefined) return runId
      if (typeof candidate !== 'string' || candidate !== runId) throw new Error('工作流运行不存在。')
      return runId
    })

    let taskId = ''
    let predictionId = ''
    try {
      const snapshot = await agent.chat('请发现建模方法，提交一个 Monod 模拟，读取结果并登记预测')
      expect(provider.calls).toBe(7)
      const task = service.list(runId)[0]!
      taskId = task.id
      predictionId = task.predictionId ?? ''
      expect(task).toMatchObject({ status: 'SUCCEEDED', linkedExperiment: 'ELN-E2E-1' })
      expect(predictionId).not.toBe('')
      const result = service.result(runId, taskId)
      expect(result.metrics.biomassIncrease).toBeGreaterThan(0)
      expect(snapshot.messages.some(message => message.role === 'assistant' && message.content.includes('ELN-E2E-1'))).toBe(true)

      const predictions = industrial.predictions(runId)
      expect(predictions).toHaveLength(1)
      expect(predictions[0]).toMatchObject({ id: predictionId, status: 'PROPOSED', linkedExperiment: 'ELN-E2E-1' })
      expect(predictions[0]!.artifactRef).toContain(`/api/modeling/tasks/${taskId}/artifacts/result`)
      // The linked prediction carries the job-derived method version, not a caller claim.
      expect(predictions[0]!.model).toContain('monod_batch v')
    } finally {
      agent.dispose()
      await service.close()
      industrial.close()
      store.close()
    }

    // Restart the service against the same data dir and database.
    const reopenedStore = new WetFlowStore(join(dir, 'workflow.db'))
    const reopenedIndustrial = new IndustrialStore(join(dir, 'industrial.db'))
    const reopenedService = new ModelingService({
      dataDir: join(dir, 'modeling'),
      validateRunId: id => { if (id !== runId) throw new Error('工作流运行不存在。') },
      createPrediction: () => ({ id: 'unused' }),
    })
    try {
      const restored = reopenedService.get(runId, taskId)
      expect(restored).toMatchObject({ status: 'SUCCEEDED', predictionId, linkedExperiment: 'ELN-E2E-1' })
      expect(reopenedService.result(runId, taskId).metrics.biomassIncrease).toBeGreaterThan(0)
      expect(reopenedIndustrial.predictions(runId).find(item => item.id === predictionId)).toMatchObject({
        status: 'PROPOSED', linkedExperiment: 'ELN-E2E-1',
      })
    } finally {
      await reopenedService.close()
      reopenedIndustrial.close()
      reopenedStore.close()
    }
  })
})
