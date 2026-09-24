import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOOP_DEADLINE_MS, MAX_MODEL_TURNS, MAX_TOOL_EXECUTIONS, WetFlowAgent } from '../src/agent/runtime.js'
import type { ModelContextFrame } from '../src/agent/context.js'
import {
  OpenAICompatibleProvider,
  toolParameterSchema,
  toolSchemaSources,
  type ModelProvider,
  type ModelRequestOptions,
  type ModelSession,
  type ModelTurn,
} from '../src/agent/provider.js'
import type { ToolRegistry } from '../src/agent/tools.js'
import type { ToolDefinition } from '../src/core/types.js'
import { WetFlowStore } from '../src/core/store.js'

const temporary: string[] = []
const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

interface RecordedCall {
  context: ModelContextFrame
  options?: ModelRequestOptions
  session?: ModelSession
}

type ScriptStep = (call: number, session: ModelSession | undefined) => ModelTurn

class ScriptedProvider implements ModelProvider {
  readonly calls: RecordedCall[] = []

  constructor(private readonly script: ScriptStep[]) {}

  defaultModel(): string { return 'fake-model' }

  async models() { return [{ id: 'fake-model', label: 'Fake' }] }

  async complete(context: ModelContextFrame, _tools: ToolRegistry, options?: ModelRequestOptions, session?: ModelSession): Promise<ModelTurn> {
    const index = this.calls.length
    this.calls.push({
      context,
      ...(options ? { options } : {}),
      ...(session ? { session: JSON.parse(JSON.stringify(session)) as ModelSession } : {}),
    })
    const step = this.script[Math.min(index, this.script.length - 1)]
    if (!step) throw new Error('script exhausted')
    return step(index, session)
  }
}

function fixture(provider: ModelProvider, options: ConstructorParameters<typeof WetFlowAgent>[2] = {}): { store: WetFlowStore; agent: WetFlowAgent } {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-loop-'))
  temporary.push(dir)
  const store = new WetFlowStore(join(dir, 'wetflow.db'))
  const agent = new WetFlowAgent(store, provider, options)
  disposers.push(() => {
    agent.dispose()
    store.close()
  })
  return { store, agent }
}

function toolCall(name: string, args: Record<string, unknown>, extra: { id?: string; rawArguments?: string; argumentsError?: string } = {}) {
  return {
    ...(extra.id ? { id: extra.id } : {}),
    name,
    arguments: args,
    ...(extra.rawArguments !== undefined ? { rawArguments: extra.rawArguments } : {}),
    ...(extra.argumentsError !== undefined ? { argumentsError: extra.argumentsError } : {}),
  }
}

function lastAssistant(agent: WetFlowAgent): string {
  return agent.snapshot().messages.filter(message => message.role === 'assistant').at(-1)?.content ?? ''
}

describe('bounded multi-turn agent loop', () => {
  it('keeps automatically retrieved documents and old conversation context out while consent is off', async () => {
    let invoked = false
    const provider = new ScriptedProvider([
      () => ({ content: '', toolCalls: [toolCall('research_source_read', { sourceId: 's1', evidenceQuote: 'secret passage' }, { id: 'read-1' })] }),
      () => ({ content: '已完成。' }),
    ])
    const { agent, store } = fixture(provider, {
      allowDocumentExcerpts: () => false,
      registerTools: registry => registry.register({
        name: 'research_source_read', description: '读取来源', approvalRequired: false, risk: 'LOW',
        execute: () => { invoked = true; return { citation: '[来源: s1]', text: 'secret passage' } },
      }),
    })
    store.addMessage('assistant', '旧回答含 secret passage')
    store.addMessage('user', '旧问题')
    store.addEvidenceSource('paper.txt', 'secret passage', 'text/plain')

    await agent.chat('只回答这次问题')

    expect(invoked).toBe(false)
    expect(provider.calls[0]?.context.messages.map(message => message.content)).toEqual(['只回答这次问题'])
    expect(provider.calls[0]?.context.evidence).toEqual([])
    expect(JSON.stringify(provider.calls[0]?.context.memory ?? {})).not.toContain('secret passage')
    expect(JSON.stringify(provider.calls[1]?.session?.messages ?? [])).not.toContain('secret passage')
    expect(provider.calls[1]?.session?.messages).toHaveLength(2)
  })

  it('stops a consented model loop before another request if consent is switched off', async () => {
    let allow = true
    const provider = new ScriptedProvider([() => ({ content: '', toolCalls: [toolCall('workflow_status', {}, { id: 'status-1' })] })])
    const { agent } = fixture(provider, { allowDocumentExcerpts: () => allow })
    const original = provider.complete.bind(provider)
    vi.spyOn(provider, 'complete').mockImplementation(async (...args) => {
      const turn = await original(...args)
      allow = false
      return turn
    })

    const snapshot = await agent.chat('检查状态')

    expect(provider.calls).toHaveLength(1)
    expect(snapshot.messages.at(-1)?.content).toContain('已停止继续调用模型')
  })

  it('executes a read-only tool, feeds the observation back, and answers in prose', async () => {
    const provider = new ScriptedProvider([
      () => ({ content: '', toolCalls: [toolCall('workflow_status', {}, { id: 'call_status_1' })] }),
      () => ({ content: '当前工作流仍在草稿阶段。' }),
    ])
    const { agent } = fixture(provider, { allowDocumentExcerpts: () => true })

    const snapshot = await agent.chat('现在工作流到哪一步了？')

    expect(provider.calls).toHaveLength(2)
    expect(lastAssistant(agent)).toBe('当前工作流仍在草稿阶段。')
    expect(snapshot.agentState).toBe('READY')
    expect(snapshot.activity.some(item => item.label === '工具执行')).toBe(true)

    // The second request must carry the exact tool_call id and the tool observation,
    // in assistant-then-tool order, without persisting either to the conversation.
    const second = provider.calls[1]?.session?.messages ?? []
    expect(second).toHaveLength(2)
    expect(second[0]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'call_status_1', name: 'workflow_status' }] })
    expect(second[1]).toMatchObject({ role: 'tool', toolCallId: 'call_status_1' })
    expect(String(second[1]?.content)).toContain('"currentStage"')
    expect(snapshot.messages.some(message => (message.role as string) === 'tool')).toBe(false)
  })

  it('handles several tool calls in one turn and preserves each full id', async () => {
    let echoArguments: Record<string, unknown> | undefined
    const provider = new ScriptedProvider([
      () => ({
        content: '',
        toolCalls: [
          toolCall('workflow_status', {}, { id: 'call_a' }),
          toolCall('echo_probe', { note: 'hello' }, { id: 'call_b' }),
        ],
      }),
      () => ({ content: '两个只读工具都已执行。' }),
    ])
    const { agent } = fixture(provider, {
      registerTools: registry => {
        const probe: ToolDefinition<Record<string, unknown>, unknown> & { parameters?: Record<string, unknown> } = {
          name: 'echo_probe',
          description: '回显给定文本。',
          approvalRequired: false,
          risk: 'LOW',
          parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false },
          execute: input => { echoArguments = input; return { echoed: input.note } },
        }
        registry.register(probe)
      },
    })

    await agent.chat('同时检查状态并回显。')

    expect(provider.calls).toHaveLength(2)
    expect(echoArguments).toEqual({ note: 'hello' })
    const second = provider.calls[1]?.session?.messages ?? []
    expect(second.map(message => message.role)).toEqual(['assistant', 'tool', 'tool'])
    expect(second[1]).toMatchObject({ role: 'tool', toolCallId: 'call_a' })
    expect(second[2]).toMatchObject({ role: 'tool', toolCallId: 'call_b' })
    expect(String(second[2]?.content)).toContain('hello')
  })

  it('round-trips reasoning_content on the assistant tool-call message', async () => {
    const provider = new ScriptedProvider([
      () => ({ content: '', reasoningContent: '先看看状态', toolCalls: [toolCall('workflow_status', {}, { id: 'call_r' })] }),
      () => ({ content: '完成。' }),
    ])
    const { agent } = fixture(provider, { allowDocumentExcerpts: () => true })
    await agent.chat('检查状态')

    const second = provider.calls[1]?.session?.messages ?? []
    expect(second[0]).toMatchObject({ role: 'assistant', reasoningContent: '先看看状态' })
  })

  it('stops executing after the 40-execution default budget and asks for a final answer', async () => {
    let executions = 0
    const provider = new ScriptedProvider([
      (_call, session) => session?.toolChoice === 'none'
        ? { content: '预算用尽，仅报告已获得的结果。' }
        : { content: '', toolCalls: [toolCall('count_read', {}, { id: 'call_n' })] },
    ])
    const { agent } = fixture(provider, {
      registerTools: registry => {
        const tool: ToolDefinition<Record<string, unknown>, unknown> = {
          name: 'count_read',
          description: '计数只读工具。',
          approvalRequired: false,
          risk: 'LOW',
          execute: () => { executions += 1; return { count: executions } },
        }
        registry.register(tool)
      },
    })

    await agent.chat('一直读下去')

    expect(MAX_TOOL_EXECUTIONS).toBe(40)
    expect(executions).toBe(40)
    expect(provider.calls).toHaveLength(41)
    expect(provider.calls.at(-1)?.session?.toolChoice).toBe('none')
    expect(lastAssistant(agent)).toBe('预算用尽，仅报告已获得的结果。')
  })

  it('honours a smaller maxToolExecutions override', async () => {
    let executions = 0
    const provider = new ScriptedProvider([
      (_call, session) => session?.toolChoice === 'none'
        ? { content: '停止。' }
        : { content: '', toolCalls: [toolCall('count_read', {}, { id: 'call_n' })] },
    ])
    const { agent } = fixture(provider, {
      maxToolExecutions: 2,
      registerTools: registry => {
        registry.register({
          name: 'count_read', description: '计数。', approvalRequired: false, risk: 'LOW',
          execute: () => { executions += 1; return { count: executions } },
        })
      },
    })

    await agent.chat('读两次')

    expect(executions).toBe(2)
    expect(provider.calls).toHaveLength(3)
    expect(provider.calls.at(-1)?.session?.toolChoice).toBe('none')
  })

  it('stops when the wall-clock loop deadline is exceeded', async () => {
    let now = new Date('2026-08-12T08:00:00.000Z')
    const provider = new ScriptedProvider([
      () => {
        now = new Date(now.getTime() + 5_000)
        return { content: '', toolCalls: [toolCall('workflow_status', {}, { id: 'call_d' })] }
      },
    ])
    const { agent } = fixture(provider, { now: () => now, loopDeadlineMs: 1_000 })

    await agent.chat('检查状态')

    expect(DEFAULT_LOOP_DEADLINE_MS).toBe(90_000)
    expect(provider.calls).toHaveLength(1)
    expect(lastAssistant(agent)).toContain('期限')
  })

  it('drives the loop deadline from a monotonic clock even when wall-clock time is frozen', async () => {
    const wall = new Date('2026-08-12T08:00:00.000Z')
    let monotonic = 0
    const provider = new ScriptedProvider([
      () => { monotonic += 5_000; return { content: '', toolCalls: [toolCall('workflow_status', {}, { id: 'call_mono' })] } },
    ])
    const { agent } = fixture(provider, { now: () => wall, monotonicNow: () => monotonic, loopDeadlineMs: 1_000 })

    const snapshot = await agent.chat('检查状态')

    expect(provider.calls).toHaveLength(1)
    expect(snapshot.turn?.status).toBe('deadline_exceeded')
    expect(snapshot.turn?.error).toContain('期限')
    expect(lastAssistant(agent)).toContain('期限')
  })

  it('reports an unfinished turn without claiming success when the turn cap is hit', async () => {
    const provider = new ScriptedProvider([
      () => ({ content: '', toolCalls: [toolCall('workflow_status', {}, { id: 'call_t' })] }),
    ])
    const { agent } = fixture(provider, { maxModelTurns: 3 })

    await agent.chat('检查状态')

    expect(provider.calls).toHaveLength(3)
    expect(MAX_MODEL_TURNS).toBe(48)
    expect(lastAssistant(agent)).toContain('上限')
  })
})

describe('loop error handling and approval boundary', () => {
  it('feeds an unknown tool back as an observation instead of aborting', async () => {
    const provider = new ScriptedProvider([
      () => ({ content: '', toolCalls: [toolCall('does_not_exist', {}, { id: 'call_u' })] }),
      () => ({ content: '无法使用该工具，改为直接回答。' }),
    ])
    const { agent } = fixture(provider)

    await agent.chat('调用一个不存在的工具')

    const second = provider.calls[1]?.session?.messages ?? []
    expect(second[1]).toMatchObject({ role: 'tool', toolCallId: 'call_u' })
    expect(String(second[1]?.content)).toContain('未知工具')
    expect(lastAssistant(agent)).toBe('无法使用该工具，改为直接回答。')
  })

  it('rejects malformed JSON arguments without executing the tool', async () => {
    const provider = new ScriptedProvider([
      () => ({
        content: '',
        toolCalls: [toolCall('workflow_advance', {}, { id: 'call_bad', rawArguments: 'not-json', argumentsError: 'Unexpected token' })],
      }),
      () => ({ content: '参数无效，未执行。' }),
    ])
    const { store, agent } = fixture(provider)

    const before = store.workflow().currentStage
    const snapshot = await agent.chat('推进到下一步')

    expect(snapshot.approvals).toEqual([])
    expect(snapshot.workflow.currentStage).toBe(before)
    expect(store.approvals()).toEqual([])
    const second = provider.calls[1]?.session?.messages ?? []
    expect(String(second[1]?.content)).toContain('不是有效 JSON')
  })

  it('rejects arguments that miss required schema fields without staging a proposal', async () => {
    const provider = new ScriptedProvider([
      () => ({ content: '', toolCalls: [toolCall('workflow_advance', {}, { id: 'call_missing' })] }),
      () => ({ content: '缺少 stage，未创建提案。' }),
    ])
    const { store, agent } = fixture(provider)

    const before = store.workflow().currentStage
    const snapshot = await agent.chat('推进到下一步')

    expect(snapshot.approvals).toEqual([])
    expect(store.approvals()).toEqual([])
    expect(snapshot.workflow.currentStage).toBe(before)
    const second = provider.calls[1]?.session?.messages ?? []
    expect(String(second[1]?.content)).toContain('stage')
  })

  it('surfaces a provider failure as a normal answer and changes no state', async () => {
    const provider: ModelProvider = {
      defaultModel: () => 'fake-model',
      models: async () => [{ id: 'fake-model', label: 'Fake' }],
      complete: async () => { throw new Error('连接被拒绝') },
    }
    const { store, agent } = fixture(provider)

    const before = store.workflow().currentStage
    const snapshot = await agent.chat('检查状态')

    expect(snapshot.agentState).toBe('READY')
    expect(lastAssistant(agent)).toContain('模型请求失败')
    expect(lastAssistant(agent)).toContain('连接被拒绝')
    expect(snapshot.approvals).toEqual([])
    expect(store.workflow().currentStage).toBe(before)
  })

  it('creates one persistent proposal for an approval tool and stops without executing anything after it', async () => {
    let readonlyRuns = 0
    const provider = new ScriptedProvider([
      () => ({
        content: '我准备推进工作流。',
        toolCalls: [
          toolCall('workflow_advance', { stage: 'DESIGN_APPROVED' }, { id: 'call_approval' }),
          toolCall('count_read', {}, { id: 'call_after' }),
        ],
      }),
    ])
    const { store, agent } = fixture(provider, {
      registerTools: registry => {
        registry.register({
          name: 'count_read', description: '计数。', approvalRequired: false, risk: 'LOW',
          execute: () => { readonlyRuns += 1; return { count: readonlyRuns } },
        })
      },
    })

    const before = store.workflow().currentStage
    const snapshot = await agent.chat('推进到下一步')

    expect(readonlyRuns).toBe(0)
    expect(snapshot.workflow.currentStage).toBe(before)
    expect(snapshot.workflow.status).toBe('WAITING_APPROVAL')
    expect(snapshot.approvals).toHaveLength(1)
    expect(snapshot.approvals[0]).toMatchObject({ tool: 'workflow_advance', status: 'PENDING' })
    expect(store.approvals()).toHaveLength(1)
    expect(lastAssistant(agent)).toContain('需要你明确通过')
    // No tool observation for the skipped call: the loop stopped at the proposal.
    expect(snapshot.messages.some(message => message.content.includes('已执行'))).toBe(false)

    const approval = snapshot.approvals[0]
    const committed = await agent.decide(approval?.id ?? '', 'approve')
    expect(committed.workflow.currentStage).toBe('DESIGN_APPROVED')
  })

  it('does not execute a read-only tool whose arguments violate its declared schema', async () => {
    let runs = 0
    const provider = new ScriptedProvider([
      () => ({ content: '', toolCalls: [toolCall('needs_number', { amount: 'many' }, { id: 'call_type' })] }),
      () => ({ content: '参数类型不对。' }),
    ])
    const { agent } = fixture(provider, {
      registerTools: registry => {
        const tool: ToolDefinition<Record<string, unknown>, unknown> & { parameters?: Record<string, unknown> } = {
          name: 'needs_number',
          description: '需要一个数字。',
          approvalRequired: false,
          risk: 'LOW',
          parameters: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'], additionalProperties: false },
          execute: () => { runs += 1; return { ok: true } },
        }
        registry.register(tool)
      },
    })

    await agent.chat('用数字调用')

    expect(runs).toBe(0)
    const second = provider.calls[1]?.session?.messages ?? []
    expect(String(second[1]?.content)).toContain('类型应为 number')
  })

  it('counts a throwing tool invocation toward the budget and tracks failures separately', async () => {
    let calls = 0
    const provider = new ScriptedProvider([
      (_call, session) => session?.toolChoice === 'none'
        ? { content: '停止并报告。' }
        : { content: '', toolCalls: [toolCall('explode', {}, { id: 'call_f' })] },
    ])
    const { agent } = fixture(provider, {
      maxToolExecutions: 3,
      registerTools: registry => {
        registry.register({
          name: 'explode', description: '总是抛错。', approvalRequired: false, risk: 'LOW',
          execute: () => { calls += 1; throw new Error('副作用可能已发生') },
        })
      },
    })

    const snapshot = await agent.chat('调用会抛错的工具')

    expect(calls).toBe(3)
    expect(snapshot.turn?.toolExecutions).toBe(3)
    expect(snapshot.turn?.toolFailures).toBe(3)
    expect(snapshot.turn?.toolSuccesses).toBe(0)
    expect(snapshot.turn?.toolBudgetReached).toBe(true)
    expect(provider.calls.at(-1)?.session?.toolChoice).toBe('none')
  })

  it('rejects unknown extra keys for a schema that declares additionalProperties false', async () => {
    let runs = 0
    const provider = new ScriptedProvider([
      () => ({ content: '', toolCalls: [toolCall('strict_tool', { known: 'ok', extra: 'nope' }, { id: 'call_extra' })] }),
      () => ({ content: '额外字段被拒绝。' }),
    ])
    const { agent } = fixture(provider, {
      registerTools: registry => {
        registry.register({
          name: 'strict_tool', description: '严格 schema。', approvalRequired: false, risk: 'LOW',
          parameters: { type: 'object', properties: { known: { type: 'string' } }, required: ['known'], additionalProperties: false },
          execute: () => { runs += 1; return { ok: true } },
        })
      },
    })

    const snapshot = await agent.chat('带多余字段调用')

    expect(runs).toBe(0)
    expect(snapshot.turn?.toolExecutions).toBe(0)
    const second = provider.calls[1]?.session?.messages ?? []
    expect(String(second[1]?.content)).toContain('不在允许的字段内')
  })
})

describe('registerTools registration order', () => {
  it('calls the host hook after the built-in tools exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-register-'))
    temporary.push(dir)
    const store = new WetFlowStore(join(dir, 'wetflow.db'))
    let seen: string[] = []
    const agent = new WetFlowAgent(store, undefined, {
      registerTools: registry => {
        seen = registry.list().map(tool => tool.name)
        registry.register({ name: 'extra_tool', description: '额外工具。', approvalRequired: false, risk: 'LOW', execute: () => ({}) })
      },
    })
    disposers.push(() => { agent.dispose(); store.close() })

    expect(seen).toEqual(['workflow_status', 'workflow_advance', 'workflow_pause', 'workflow_wake'])
    expect(agent.snapshot().tools.map(tool => tool.name)).toContain('extra_tool')
  })
})

describe('OpenAICompatibleProvider request shape', () => {
  function frame(overrides: Partial<ModelContextFrame> = {}): ModelContextFrame {
    return {
      instructions: '系统提示',
      workflow: {
        id: 'wf-1', projectId: 'p-1', name: '运行', project: '项目', revision: 1,
        currentStage: 'DRAFT', status: 'RUNNING', updatedAt: '2026-08-12T08:00:00.000Z', completedStages: [],
      },
      evidence: [],
      messages: [],
      tools: [],
      ...overrides,
    } as ModelContextFrame
  }

  it('sends definitions() schemas, round-trips tool ids and reasoning_content, and honours tool_choice none', async () => {
    let body: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            reasoning_content: '思考中',
            tool_calls: [
              { id: 'call_1', function: { name: 'workflow_status', arguments: '{}' } },
              { id: 'call_2', function: { name: 'custom_tool', arguments: '{"runId":"r1"}' } },
            ],
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const registry = {
      definitions: () => [
        { name: 'workflow_status', description: '状态', parameters: { type: 'object', properties: { runId: { type: 'string' } }, additionalProperties: false } },
        { name: 'workflow_advance', description: '推进' },
      ],
      list: () => [],
    } as unknown as ToolRegistry
    const provider = new OpenAICompatibleProvider({ baseUrl: 'http://model.test/v1', apiKey: 'k', model: 'm' })

    const turn = await provider.complete(frame(), registry, {}, {
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_prev', name: 'workflow_status', arguments: '{}' }], reasoningContent: '上轮推理' },
        { role: 'tool', content: '{"currentStage":"DRAFT"}', toolCallId: 'call_prev', name: 'workflow_status' },
      ],
      toolChoice: 'none',
    })

    const tools = body?.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>
    expect(tools[0]?.function.parameters).toMatchObject({ properties: { runId: { type: 'string' } } })
    // No parameters on the second definition: the legacy workflow_advance schema applies.
    expect(tools[1]?.function.parameters).toMatchObject({ required: ['stage'], additionalProperties: false })
    expect(body?.tool_choice).toBe('none')

    const messages = body?.messages as Array<Record<string, unknown>>
    const assistantHistory = messages.find(message => message.role === 'assistant' && Array.isArray(message.tool_calls))
    expect(assistantHistory).toMatchObject({
      reasoning_content: '上轮推理',
      tool_calls: [{ id: 'call_prev', type: 'function', function: { name: 'workflow_status', arguments: '{}' } }],
    })
    expect(messages.find(message => message.role === 'tool')).toMatchObject({ tool_call_id: 'call_prev' })

    expect(turn.toolCalls).toHaveLength(2)
    expect(turn.toolCalls?.[0]).toMatchObject({ id: 'call_1', name: 'workflow_status' })
    expect(turn.toolCalls?.[1]).toMatchObject({ id: 'call_2', arguments: { runId: 'r1' } })
    expect(turn.reasoningContent).toBe('思考中')
  })

  it('marks unparseable arguments instead of throwing', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      choices: [{ message: { content: '', tool_calls: [{ id: 'call_x', function: { name: 'custom_tool', arguments: '{broken' } }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const registry = { list: () => [] } as unknown as ToolRegistry
    const provider = new OpenAICompatibleProvider({ baseUrl: 'http://model.test/v1', apiKey: 'k', model: 'm' })

    const turn = await provider.complete(frame(), registry)

    expect(turn.toolCalls?.[0]).toMatchObject({ id: 'call_x', name: 'custom_tool', rawArguments: '{broken', arguments: {} })
    expect(turn.toolCalls?.[0]?.argumentsError).toBeTruthy()
  })

  it('falls back to the legacy list() view when definitions() is unavailable', () => {
    const registry = {
      list: () => [{ name: 'workflow_pause', description: '暂停', approvalRequired: true }],
    } as unknown as ToolRegistry
    expect(toolSchemaSources(registry)).toEqual([{ name: 'workflow_pause', description: '暂停' }])
    expect(toolParameterSchema('workflow_pause')).toMatchObject({ additionalProperties: false })
    expect(toolParameterSchema('custom', { type: 'object', properties: { a: { type: 'string' } } }))
      .toMatchObject({ properties: { a: { type: 'string' } } })
  })
})
