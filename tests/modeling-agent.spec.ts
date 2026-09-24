import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_TOOL_EXECUTIONS, WetFlowAgent } from '../src/agent/runtime.js'
import { registerModelingTools } from '../src/agent/modeling-tools.js'
import type { ModelContextFrame } from '../src/agent/context.js'
import type {
  ModelProvider,
  ModelRequestOptions,
  ModelSession,
  ModelTurn,
} from '../src/agent/provider.js'
import type { ToolRegistry } from '../src/agent/tools.js'
import type { ChatMessage } from '../src/core/types.js'
import { WetFlowStore } from '../src/core/store.js'
import { ModelingService } from '../src/modeling/service.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

type Script = (turn: number, context: ModelContextFrame, session?: ModelSession) => ModelTurn | Promise<ModelTurn>

/**
 * Scripted provider for the merged core loop. The durable `context.messages`
 * never carry live tool exchanges; the in-flight assistant tool_call plus its
 * `role='tool'` results travel on `session.messages`, exactly as the current
 * runtime sends them to a real provider.
 */
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

const lastToolResult = (session: ModelSession | undefined, name: string) =>
  [...(session?.messages ?? [])].reverse().find(message => message.role === 'tool' && message.name === name)

function parseTool(message: { content: string } | undefined): Record<string, unknown> | undefined {
  if (!message) return undefined
  try { return JSON.parse(message.content) as Record<string, unknown> } catch { return undefined }
}

/**
 * Assistant transcript text, independent of store message ordering. Messages
 * written in the same millisecond are ordered non-deterministically by SQLite.
 */
function assistantText(snapshot: { messages: ChatMessage[] }): string {
  return snapshot.messages.filter(message => message.role === 'assistant').map(message => message.content).join('\n')
}

interface Harness {
  dir: string
  runId: string
  store: WetFlowStore
  service: ModelingService
  agent: WetFlowAgent
  provider: ScriptedProvider
}

function harness(script: Script, options: { slowWorker?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-agent-'))
  dirs.push(dir)
  const store = new WetFlowStore(join(dir, 'workflow.db'))
  const runId = store.workflow().id
  let workerScript: string | undefined
  if (options.slowWorker) {
    workerScript = join(dir, 'slow-worker.py')
    writeFileSync(workerScript, 'import time\ntime.sleep(5)\nraise SystemExit(1)\n')
  }
  const service = new ModelingService({
    dataDir: join(dir, 'modeling'),
    validateRunId: id => { if (id !== runId) throw new Error('工作流运行不存在。') },
    createPrediction: () => ({ id: 'prediction-agent' }),
    ...(workerScript ? { workerScript } : {}),
  })
  const provider = new ScriptedProvider(script)
  const agent = new WetFlowAgent(store, provider)
  registerModelingTools(agent.tools, () => service, candidate => {
    if (candidate === undefined) return runId
    if (typeof candidate !== 'string' || candidate !== runId) throw new Error('工作流运行不存在。')
    return runId
  })
  return { dir, runId, store, service, agent, provider }
}

async function teardown(current: Harness): Promise<void> {
  current.agent.dispose()
  await current.service.close()
  current.store.close()
}

const monodParameters = {
  initialBiomass: 0.1, initialSubstrate: 2, muMax: 0.4,
  halfSaturation: 0.1, yield: 0.5, duration: 0.2, timeStep: 0.1,
}

const waitForTerminal = async (service: ModelingService, runId: string, taskId: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = service.get(runId, taskId)
    if (task.status !== 'QUEUED' && task.status !== 'RUNNING') return task
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('modeling task did not reach a terminal state')
}

describe('agent native modeling tool loop', () => {
  it('feeds tool results back as role=tool messages bound to assistant tool_call ids', async () => {
    let submittedTaskId = ''
    const current = harness((turn, context, session) => {
      if (turn === 1) return { content: '先查看可用方法。', toolCall: { id: 'call-methods', name: 'modeling_methods', arguments: {} } }
      if (turn === 2) {
        // The second provider request must contain the real tool exchange on the
        // in-flight session, not a fabricated user turn carrying the tool output.
        const userMessages = context.messages.filter(message => message.role === 'user')
        expect(userMessages).toHaveLength(1)
        expect(userMessages[0]?.content).toBe('查看模型方法并提交一个 Monod 模拟')
        const callMessage = (session?.messages ?? []).find(message => message.role === 'assistant' && message.toolCalls.length)
        expect(callMessage?.role === 'assistant' ? callMessage.toolCalls[0] : undefined)
          .toMatchObject({ id: 'call-methods', name: 'modeling_methods' })
        const result = lastToolResult(session, 'modeling_methods')
        expect(result?.role === 'tool' ? result.toolCallId : undefined).toBe('call-methods')
        expect(result?.content).toContain('monod_batch')
        return {
          content: '提交本地 Monod 模拟。',
          toolCall: { id: 'call-submit', name: 'modeling_submit', arguments: { method: 'monod_batch', parameters: monodParameters } },
        }
      }
      const submitResult = parseTool(lastToolResult(session, 'modeling_submit'))
      submittedTaskId = String(submitResult?.id ?? '')
      expect(submittedTaskId).not.toBe('')
      return { content: `已提交任务 ${submittedTaskId}，稍后查询状态。` }
    })
    try {
      const snapshot = await current.agent.chat('查看模型方法并提交一个 Monod 模拟')
      expect(current.provider.calls).toBe(3)
      expect(submittedTaskId).not.toBe('')
      // The current core keeps live tool exchanges on the in-flight session only;
      // the durable conversation never persists a raw role='tool' message.
      expect(snapshot.messages.map(message => message.role as string)).not.toContain('tool')
      expect(snapshot.messages.some(message => message.role === 'assistant')).toBe(true)
      expect(assistantText(snapshot)).toContain(submittedTaskId)
      const terminal = await waitForTerminal(current.service, current.runId, submittedTaskId)
      expect(terminal.status).toBe('SUCCEEDED')
      const result = current.service.result(current.runId, submittedTaskId)
      expect(result.metrics.biomassIncrease).toBeGreaterThan(0)
    } finally { await teardown(current) }
  })

  it('feeds backend validation errors back as role=tool instead of throwing or creating a job', async () => {
    const current = harness((turn, _context, session) => {
      if (turn === 1) {
        return {
          content: '提交缺少参数的任务。',
          toolCall: { id: 'call-bad', name: 'modeling_submit', arguments: { method: 'monod_batch', parameters: { initialBiomass: 0.1 } } },
        }
      }
      const observation = lastToolResult(session, 'modeling_submit')?.content ?? ''
      expect(observation).toContain('执行失败')
      expect(observation.length).toBeGreaterThan(0)
      return { content: '参数错误，任务未创建。' }
    })
    try {
      const snapshot = await current.agent.chat('提交一个参数不完整的模拟')
      expect(current.provider.calls).toBe(2)
      expect(current.service.list(current.runId)).toHaveLength(0)
      expect(snapshot.approvals).toHaveLength(0)
      expect(assistantText(snapshot)).toContain('参数错误，任务未创建。')
    } finally { await teardown(current) }
  })

  it('reports an unknown tool as a role=tool error and keeps the turn alive', async () => {
    const current = harness(turn => {
      if (turn === 1) return { content: '', toolCall: { id: 'call-unknown', name: 'modeling_bogus', arguments: {} } }
      return { content: '该工具不可用。' }
    })
    try {
      await current.agent.chat('调用一个不存在的建模工具')
      const observation = lastToolResult(current.provider.sessions[1], 'modeling_bogus')?.content ?? ''
      expect(observation).toContain('未知工具')
      expect(current.provider.calls).toBe(2)
    } finally { await teardown(current) }
  })

  it('bounds stubborn repeated status calls by the shared 40-execution budget and never claims success early', async () => {
    const current = harness((turn, _context, session) => {
      if (turn === 1) {
        return { content: '提交长任务。', toolCall: { id: 'call-submit', name: 'modeling_submit', arguments: { method: 'monod_batch', parameters: monodParameters } } }
      }
      if (session?.toolChoice === 'none') return { content: '预算用尽，任务仍在排队或运行。' }
      // A stubborn model keeps asking for the same status. The shared tool budget
      // must stop it; the loop never waits on or forges the long job.
      const taskId = parseTool(lastToolResult(session, 'modeling_submit'))?.id
      expect(typeof taskId).toBe('string')
      return { content: '继续查询。', toolCall: { id: `call-status-${turn}`, name: 'modeling_status', arguments: { taskId: String(taskId) } } }
    }, { slowWorker: true })
    try {
      const snapshot = await current.agent.chat('提交并等待长任务完成')
      expect(current.provider.calls).toBe(MAX_TOOL_EXECUTIONS + 1)
      const final = assistantText(snapshot)
      expect(final).toContain('预算用尽')
      expect(final).not.toContain('SUCCEEDED')
      expect(snapshot.turn?.toolExecutions).toBe(MAX_TOOL_EXECUTIONS)
      const task = current.service.list(current.runId)[0]!
      // The loop did not wait for the slow worker; the job is still in flight.
      expect(['QUEUED', 'RUNNING']).toContain(task.status)
    } finally { await teardown(current) }
  })

  it('bounds the modeling tool loop at the shared tool-execution cap', async () => {
    const current = harness((turn, _context, session) => {
      if (session?.toolChoice === 'none') return { content: '达到上限，停止重复调用。' }
      // Distinct signatures each turn so this exercises the shared cap, not a
      // modeling-specific repeat guard.
      if (turn % 2 === 1) {
        return { content: '', toolCall: { id: `call-datasets-${turn}`, name: 'modeling_datasets', arguments: {} } }
      }
      return { content: '', toolCall: { id: `call-methods-${turn}`, name: 'modeling_methods', arguments: {} } }
    })
    try {
      const snapshot = await current.agent.chat('反复查看方法与数据集')
      expect(current.provider.calls).toBe(MAX_TOOL_EXECUTIONS + 1)
      expect(current.provider.sessions.at(-1)?.toolChoice).toBe('none')
      expect(snapshot.turn?.toolExecutions).toBe(MAX_TOOL_EXECUTIONS)
      // The provider was asked for a final answer once the shared cap was hit.
      expect(assistantText(snapshot)).toContain('上限')
    } finally { await teardown(current) }
  })

  it('still stages a workflow approval after modeling tool calls without changing the workflow', async () => {
    const current = harness(turn => {
      if (turn === 1) return { content: '', toolCall: { id: 'call-1', name: 'modeling_methods', arguments: {} } }
      return { content: '需要推进到设计批准。', toolCall: { id: 'call-2', name: 'workflow_advance', arguments: { stage: 'DESIGN_APPROVED' } } }
    })
    try {
      const initialStage = current.store.workflow().currentStage
      const staged = await current.agent.chat('查看建模方法并推进工作流')
      expect(staged.workflow.currentStage).toBe(initialStage)
      expect(staged.workflow.status).toBe('WAITING_APPROVAL')
      const approval = staged.approvals.find(item => item.status === 'PENDING')
      expect(approval).toMatchObject({ tool: 'workflow_advance', workflowRevision: staged.workflow.revision })
      const committed = await current.agent.decide(approval?.id ?? '', 'approve')
      expect(committed.workflow.currentStage).toBe('DESIGN_APPROVED')
    } finally { await teardown(current) }
  })

  it('refuses cross-run task access through the agent tools and feeds the error back', async () => {
    const current = harness(turn => {
      if (turn === 1) {
        return { content: '', toolCall: { id: 'call-submit', name: 'modeling_submit', arguments: { method: 'monod_batch', parameters: monodParameters } } }
      }
      if (turn === 2) {
        return {
          content: '尝试跨运行查看。',
          toolCall: {
            id: 'call-cross', name: 'modeling_status',
            arguments: { runId: 'other-run', taskId: 'task-from-another-run' },
          },
        }
      }
      return { content: '尝试跨运行查看。' }
    })
    try {
      const snapshot = await current.agent.chat('跨运行查询任务')
      const observation = lastToolResult(current.provider.sessions[2], 'modeling_status')?.content ?? ''
      expect(observation).toContain('工作流运行不存在')
      expect(assistantText(snapshot)).toContain('尝试跨运行查看。')
    } finally { await teardown(current) }
  })
})
