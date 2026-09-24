import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WetFlowAgent } from '../src/agent/runtime.js'
import { registerModelingTools } from '../src/agent/modeling-tools.js'
import type { ModelContextFrame } from '../src/agent/context.js'
import type { ModelProvider, ModelRequestOptions, ModelSession, ModelTurn } from '../src/agent/provider.js'
import type { ToolRegistry } from '../src/agent/tools.js'
import type { ChatMessage } from '../src/core/types.js'
import { WetFlowStore } from '../src/core/store.js'
import { ModelingService } from '../src/modeling/service.js'
import { IndustrialStore, type IndustrialActor } from '../src/industrial/index.js'
import { createModelingPrediction } from '../src/server.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const actor: IndustrialActor = { id: 'wetflow-final-test', role: 'application' }

const monodParameters = {
  initialBiomass: 0.1, initialSubstrate: 2, muMax: 0.4,
  halfSaturation: 0.1, yield: 0.5, duration: 0.4, timeStep: 0.1,
}

async function waitForTerminal(service: ModelingService, runId: string, taskId: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const task = service.get(runId, taskId)
    if (task.status !== 'QUEUED' && task.status !== 'RUNNING') return task
    await sleep(25)
  }
  throw new Error('modeling task did not reach a terminal state')
}

describe('conversation ordering regression', () => {
  it('keeps same-millisecond messages in insertion order using the rowid tie-break', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-store-order-')); dirs.push(dir)
    const path = join(dir, 'wetflow.db')
    const store = new WetFlowStore(path)
    try {
      const conversationId = store.activeConversationId()
      const raw = new DatabaseSync(path)
      const insert = raw.prepare(`INSERT INTO messages (id, role, content, approval_id, created_at, conversation_id)
        VALUES (?, ?, ?, NULL, ?, ?)`)
      const ids = ['same-0', 'same-1', 'same-2', 'same-3']
      ids.forEach((messageId, index) => insert.run(
        messageId, index % 2 === 0 ? 'user' : 'assistant', `same-ts-${index}`,
        '2026-01-01T00:00:00.000Z', conversationId,
      ))
      raw.close()

      expect(store.messages().filter(message => message.id.startsWith('same-')).map(message => message.id)).toEqual(ids)
      // The insert-order path (rowid) already used by the model context is unchanged.
      expect(store.messagesForContext().filter(message => message.id.startsWith('same-')).map(message => message.id)).toEqual(ids)
    } finally { store.close() }
  })
})

describe('prediction idempotence across the task-persist crash gap', () => {
  it('resolves the same persisted prediction after restart instead of duplicating it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-pred-idem-')); dirs.push(dir)
    const workflowPath = join(dir, 'workflow.db')
    const industrialPath = join(dir, 'industrial.db')
    const dataDir = join(dir, 'modeling')

    const store = new WetFlowStore(workflowPath)
    const runId = store.workflow().id
    const industrial = new IndustrialStore(industrialPath)
    const service = new ModelingService({
      dataDir,
      validateRunId: id => { if (id !== runId) throw new Error('工作流运行不存在。') },
      createPrediction: (rid, input) => createModelingPrediction(industrial, rid, input),
    })

    let taskId = ''
    let preexistingId = ''
    try {
      const task = service.submit(runId, { method: 'monod_batch', parameters: monodParameters })
      taskId = task.id
      expect((await waitForTerminal(service, runId, taskId)).status).toBe('SUCCEEDED')

      // Fault injection: the prediction row is written, then the process dies before
      // the modeling task is updated with its id.
      const artifactRef = `/api/modeling/tasks/${taskId}/artifacts/result?runId=${encodeURIComponent(runId)}`
      preexistingId = createModelingPrediction(industrial, runId, {
        model: 'monod_batch v-interrupted', artifactRef,
        prediction: 'Prediction written before the interrupted task update', reason: 'fault injection',
      }).id
      expect(industrial.predictions(runId)).toHaveLength(1)
      expect(service.get(runId, taskId).predictionId).toBeUndefined()
    } finally {
      await service.close()
      industrial.close()
      store.close()
    }

    // Restart: the retry must resolve the existing row, not create a duplicate.
    const reopenedStore = new WetFlowStore(workflowPath)
    const reopenedIndustrial = new IndustrialStore(industrialPath)
    const reopenedService = new ModelingService({
      dataDir,
      validateRunId: id => { if (id !== runId) throw new Error('工作流运行不存在。') },
      createPrediction: (rid, input) => createModelingPrediction(reopenedIndustrial, rid, input),
      linkPrediction: (rid, predictionId, experimentRef, note) => {
        const prediction = reopenedIndustrial.prediction(predictionId)
        if (!prediction || prediction.workflowRunId !== rid) throw new Error('预测不存在。')
        reopenedIndustrial.linkPredictionExperiment(predictionId, experimentRef, note, actor)
      },
    })
    try {
      const registered = reopenedService.registerPrediction(runId, taskId, { prediction: 'Retry after restart' })
      expect(registered.predictionId).toBe(preexistingId)
      expect(reopenedService.get(runId, taskId).predictionId).toBe(preexistingId)
      expect(reopenedIndustrial.predictions(runId)).toHaveLength(1)

      // Linking keeps the note, scopes to the run, and never marks TESTED/CONFIRMED.
      reopenedService.linkExperiment(runId, taskId, { experimentRef: 'ELN-FAULT-1', note: 'follow-up measurement' })
      expect(reopenedIndustrial.predictions(runId)[0]).toMatchObject({
        id: preexistingId, status: 'PROPOSED', linkedExperiment: 'ELN-FAULT-1',
      })
      expect(reopenedService.get(runId, taskId).linkedExperimentNote).toBe('follow-up measurement')

      // Repeating the retry stays a no-op.
      expect(reopenedService.registerPrediction(runId, taskId, { prediction: 'Retry again' }).predictionId).toBe(preexistingId)
      expect(reopenedIndustrial.predictions(runId)).toHaveLength(1)
      expect(reopenedIndustrial.predictionByArtifact(runId, 'other-artifact')).toBeUndefined()
    } finally {
      await reopenedService.close()
      reopenedIndustrial.close()
      reopenedStore.close()
    }
  })
})

// ------------------------------------------------------------- list-tasks tool

class ScriptedProvider implements ModelProvider {
  calls = 0
  readonly contexts: ModelContextFrame[] = []
  readonly sessions: Array<ModelSession | undefined> = []
  constructor(private readonly script: (turn: number, context: ModelContextFrame, tools: ToolRegistry, session?: ModelSession) => ModelTurn | Promise<ModelTurn>) {}
  async complete(context: ModelContextFrame, tools: ToolRegistry, _options?: ModelRequestOptions, session?: ModelSession): Promise<ModelTurn> {
    this.calls += 1
    this.contexts.push(context)
    this.sessions.push(session ? structuredClone(session) : undefined)
    return await this.script(this.calls, context, tools, session)
  }
  models() { return Promise.resolve([{ id: 'fake', label: 'Fake' }]) }
  defaultModel() { return 'fake' }
}

function parseTool(session: ModelSession | undefined, name: string): Record<string, unknown> {
  const message = [...(session?.messages ?? [])].reverse().find(item => item.role === 'tool' && item.name === name)
  if (!message || message.role !== 'tool') return {}
  try {
    const parsed = JSON.parse(message.content) as Record<string, unknown>
    return parsed.result && typeof parsed.result === 'object' ? parsed.result as Record<string, unknown> : parsed
  } catch { return {} }
}

function assistantText(snapshot: { messages: ChatMessage[] }): string {
  return snapshot.messages.filter(message => message.role === 'assistant').map(message => message.content).join('\n')
}

describe('modeling_list_tasks agent tool', () => {
  it('is schema-exposed, run-scoped, bounded, and usable for cross-turn discovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-list-tasks-')); dirs.push(dir)
    const store = new WetFlowStore(join(dir, 'workflow.db'))
    const runId = store.workflow().id
    const service = new ModelingService({
      dataDir: join(dir, 'modeling'),
      validateRunId: id => { if (!store.workflowRuns().some(run => run.id === id)) throw new Error('工作流运行不存在。') },
      createPrediction: () => ({ id: 'unused' }),
    })
    const submitProvider = new ScriptedProvider((turn, _context, tools) => {
      if (turn === 1) {
        // The registry exposes a real JSON schema to the provider.
        expect(tools.get('modeling_list_tasks').parameters).toMatchObject({
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
        })
        return { content: '提交任务。', toolCall: { id: 's1', name: 'modeling_submit', arguments: { method: 'monod_batch', parameters: monodParameters } } }
      }
      return { content: '任务已提交。' }
    })
    const agent = new WetFlowAgent(store, submitProvider)
    registerModelingTools(agent.tools, () => service, candidate => {
      if (candidate === undefined) return store.workflow().id
      if (typeof candidate !== 'string' || !store.workflowRuns().some(run => run.id === candidate)) throw new Error('工作流运行不存在。')
      return candidate
    })
    try {
      expect(agent.tools.definitions().some(tool => tool.name === 'modeling_list_tasks' && tool.parameters)).toBe(true)

      await agent.chat('提交一个 Monod 模拟')
      const firstTask = service.list(runId)[0]!
      expect((await waitForTerminal(service, runId, firstTask.id)).status).toBe('SUCCEEDED')
      // Two more tasks so the bounded list has something to truncate.
      service.submit(runId, { method: 'monod_batch', parameters: monodParameters })
      service.submit(runId, { method: 'monod_batch', parameters: monodParameters })

      // Later conversation in the same run can rediscover the earlier task id.
      agent.newConversation()
      const listProvider = new ScriptedProvider(turn => turn === 1
        ? { content: '列出最近任务。', toolCall: { id: 'l1', name: 'modeling_list_tasks', arguments: {} } }
        : { content: '已列出。' })
      agent.setProvider(listProvider)
      const listedSnapshot = await agent.chat('帮我找到之前提交的建模任务')
      const listed = parseTool(listProvider.sessions[1], 'modeling_list_tasks')
      const items = listed.items as Array<{ id: string }>
      expect(items.map(item => item.id)).toContain(firstTask.id)
      expect(listed.total).toBe(3)
      expect(listed.truncated).toBe(false)
      expect(assistantText(listedSnapshot)).toContain('已列出。')

      // limit is honored and bounded.
      const boundedProvider = new ScriptedProvider(turn => turn === 1
        ? { content: '只取一条。', toolCall: { id: 'l2', name: 'modeling_list_tasks', arguments: { limit: 1 } } }
        : { content: '已取一条。' })
      agent.setProvider(boundedProvider)
      await agent.chat('只列出一条任务')
      const bounded = parseTool(boundedProvider.sessions[1], 'modeling_list_tasks')
      expect((bounded.items as unknown[]).length).toBe(1)
      expect(bounded.total).toBe(3)
      expect(bounded.truncated).toBe(true)

      // A different run sees its own (empty) task list.
      agent.newWorkflowRun('第二运行')
      const otherRunProvider = new ScriptedProvider(turn => turn === 1
        ? { content: '列出。', toolCall: { id: 'l3', name: 'modeling_list_tasks', arguments: {} } }
        : { content: '已列出。' })
      agent.setProvider(otherRunProvider)
      await agent.chat('列出当前运行任务')
      const otherListed = parseTool(otherRunProvider.sessions[1], 'modeling_list_tasks')
      expect(otherListed.items).toEqual([])
      expect(otherListed.total).toBe(0)
    } finally {
      agent.dispose()
      await service.close()
      store.close()
    }
  })
})
