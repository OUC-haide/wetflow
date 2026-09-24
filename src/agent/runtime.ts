import { EventEmitter } from 'node:events'
import type { AgentEvent, AgentSnapshot, AgentTurnStats, AgentTurnStatus, ApprovalRequest, ToolAuthorizationContext, ToolDefinition, ToolProposal } from '../core/types.js'
import type { WetFlowStore } from '../core/store.js'
import { createWetFlowTools, proposalForMessage, type ToolRegistry } from './tools.js'
import { composeModelContext, type ModelContextFrame } from './context.js'
import { EVIDENCE_RESPONSE_POLICY } from './evidence-policy.js'
import {
  WETFLOW_SYSTEM_PROMPT,
  toolParameterSchema,
  toolParametersOf,
  type ModelOption,
  type ModelProvider,
  type ModelRequestOptions,
  type ModelSession,
  type ModelToolCall,
  type ModelTurn,
} from './provider.js'

/** Hard cap on real tool executions inside one user turn. */
export const MAX_TOOL_EXECUTIONS = 40
/** Hard cap on provider calls inside one user turn. */
export const MAX_MODEL_TURNS = 48
/** Default wall-clock budget for one user turn, shared across all its calls. */
export const DEFAULT_LOOP_DEADLINE_MS = 90_000

const SYSTEM_PROMPT = `${WETFLOW_SYSTEM_PROMPT}\n\n${EVIDENCE_RESPONSE_POLICY}`
/** Tool observations are bounded so one huge result cannot exhaust the context. */
const MAX_OBSERVATION_CHARS = 6_000

export interface WetFlowAgentOptions {
  wakePollMs?: number
  contextTokenBudget?: number
  now?: () => Date
  /** Monotonic clock for the loop deadline; defaults to performance.now(). */
  monotonicNow?: () => number
  /** Called after the built-in workflow tools are registered so hosts can add more. */
  registerTools?: (registry: ToolRegistry) => void
  /** Wall-clock budget for a single user turn's model/tool loop. */
  loopDeadlineMs?: number
  /** Cap on real tool executions per user turn (default 40). */
  maxToolExecutions?: number
  /** Cap on provider calls per user turn. */
  maxModelTurns?: number
  /** Lazily resolved, bounded host context; never used for fetched document text. */
  additionalContext?: (workflowRunId: string) => string
  /** Consent for sending automatically retrieved document text to a cloud model. */
  allowDocumentExcerpts?: () => boolean
}

export class WetFlowAgent {
  readonly events = new EventEmitter()
  readonly tools: ToolRegistry
  private state: AgentSnapshot['agentState'] = 'READY'
  private turn: AgentTurnStats | null = null
  private readonly proposals = new Map<string, ToolProposal>()
  private readonly forwardStoreEvent = (event: AgentEvent): void => { this.events.emit('event', event) }
  private readonly wakeTimer: NodeJS.Timeout
  private waking = false

  constructor(
    readonly store: WetFlowStore,
    private provider?: ModelProvider,
    private readonly options: WetFlowAgentOptions = {},
  ) {
    this.tools = createWetFlowTools(store, options.now)
    options.registerTools?.(this.tools)
    store.events.on('event', this.forwardStoreEvent)
    this.wakeTimer = setInterval(() => { void this.checkScheduledWake() }, options.wakePollMs ?? 1_000)
    this.wakeTimer.unref()
    void this.checkScheduledWake()
  }

  dispose(): void {
    clearInterval(this.wakeTimer)
    this.store.events.off('event', this.forwardStoreEvent)
  }

  snapshot(): AgentSnapshot {
    const workflow = this.store.workflow()
    const context = this.contextFrame(workflow)
    return {
      connected: true,
      agentState: workflow.status === 'PAUSED' ? 'PAUSED' : workflow.status === 'WAITING_APPROVAL' ? 'WAITING' : this.state,
      workflow,
      context: context.stats,
      approvals: this.store.approvals(),
      messages: this.store.messages(),
      activity: this.store.activity(),
      tools: this.tools.list(),
      turn: this.turn,
    }
  }

  async modelOptions(): Promise<{ enabled: boolean; models: ModelOption[]; defaultModel: string }> {
    if (!this.provider) return { enabled: false, models: [{ id: 'builtin', label: '内置 Agent' }], defaultModel: 'builtin' }
    const models = [...await this.provider.models(), { id: 'builtin', label: '内置 Agent' }]
    return { enabled: true, models, defaultModel: this.provider.defaultModel() || models[0]?.id || '' }
  }

  setProvider(provider?: ModelProvider): void {
    this.provider = provider
  }

  newConversation(): AgentSnapshot {
    this.store.createConversation()
    this.state = 'READY'
    return this.snapshot()
  }

  switchConversation(conversationId: string): AgentSnapshot {
    this.store.activateConversation(conversationId)
    this.state = 'READY'
    return this.snapshot()
  }

  newProject(name: string): AgentSnapshot {
    this.store.createProject(name)
    this.state = 'READY'
    return this.snapshot()
  }

  newWorkflowRun(name: string, projectId?: string): AgentSnapshot {
    this.store.createWorkflowRun(name, projectId)
    this.state = 'READY'
    return this.snapshot()
  }

  switchWorkflowRun(workflowRunId: string): AgentSnapshot {
    this.store.activateWorkflowRun(workflowRunId)
    this.state = 'READY'
    return this.snapshot()
  }

  async editMessage(messageId: string, content: string, options: ModelRequestOptions = {}): Promise<AgentSnapshot> {
    const normalized = content.trim()
    const result = this.store.rewindMessage(messageId, normalized)
    for (const approvalId of result.removedApprovalIds) this.proposals.delete(approvalId)
    this.state = 'THINKING'
    return this.respond(normalized, options)
  }

  async chat(content: string, options: ModelRequestOptions = {}): Promise<AgentSnapshot> {
    const normalized = content.trim()
    if (!normalized) throw new Error('消息不能为空。')
    this.store.addMessage('user', normalized)
    this.state = 'THINKING'
    return this.respond(normalized, options)
  }

  private async respond(normalized: string, options: ModelRequestOptions): Promise<AgentSnapshot> {
    this.turn = null
    if (/唤醒|wake|恢复/.test(normalized.toLowerCase())) {
      let result: unknown
      this.store.transaction(() => {
        result = this.executeSynchronousTool('workflow_wake', {})
        this.store.addMessage('assistant', `工作流已唤醒并恢复运行。当前阶段仍为 ${(result as { currentStage: string }).currentStage}。`)
        this.store.addActivity('wake', '手动唤醒', '用户从对话恢复了工作流')
      })
      this.setTurn('answered', { toolExecutions: 1 })
      this.state = 'READY'
      return this.snapshot()
    }

    const existingApproval = this.store.approvals().find(item => item.status === 'PENDING')
    if (existingApproval) {
      this.store.addMessage('assistant', `请先处理待审批项「${existingApproval.title}」。在通过或拒绝之前，我不会再创建新的状态变更提案。`)
      this.setTurn('approval_pending', {})
      this.state = 'WAITING'
      return this.snapshot()
    }

    if (this.provider && options.model !== 'builtin') {
      return this.runModelLoop(normalized, options, this.provider)
    }

    const proposal = proposalForMessage(normalized, this.store)
    if (proposal) {
      const tool = this.tools.get(proposal.tool)
      const approval = this.store.createApproval({
        title: proposal.title,
        summary: proposal.summary,
        tool: proposal.tool,
        risk: tool.risk,
      }, proposal)
      this.proposals.set(approval.id, proposal)
      this.store.addMessage('assistant', `${proposal.summary}\n\n这项操作需要你明确通过，我会在审批前保持工作流不变。`, approval.id)
      this.setTurn('approval_pending', {})
      this.state = 'WAITING'
      return this.snapshot()
    }

    const evidence = this.store.searchEvidence(normalized, 3)
    if (evidence.length > 0 && (/资料|证据|文件|记录|文献|数据|结果|查找|检索|根据|显示/.test(normalized)
      || (evidence[0]?.score ?? 0) >= 6)) {
      const excerpts = evidence.map(chunk => {
        const content = chunk.content.replace(/\s+/g, ' ').trim()
        return `${chunk.citation}\n${content.slice(0, 360)}${content.length > 360 ? '…' : ''}`
      }).join('\n\n')
      this.store.addMessage('assistant', `在当前工作流运行的本地资料中找到以下相关片段：\n\n${excerpts}`)
      this.setTurn('answered', {})
      this.state = 'READY'
      return this.snapshot()
    }

    const workflow = await this.tools.get('workflow_status').execute({}) as AgentSnapshot['workflow']
    const stageLabel = workflow.currentStage.replaceAll('_', ' ')
    this.store.addMessage('assistant', `当前工作流「${workflow.name}」位于 ${stageLabel}，状态为 ${workflow.status}。你可以说“推进到下一步”“暂停一小时”或“唤醒工作流”。`)
    this.setTurn('answered', {})
    this.state = 'READY'
    return this.snapshot()
  }

  /**
   * Bounded model → tool → observation → answer loop for one user turn.
   *
   * - Read-only tools are executed and their results are fed back to the model
   *   until it answers in prose; a raw JSON tool result is never the answer.
   * - An approval-required tool creates exactly one durable proposal and the
   *   loop stops without executing it. The agent never approves its own proposal.
   * - Unknown tools, malformed arguments and failing tools become an error
   *   observation for the next model turn instead of aborting the request.
   * - At most maxToolExecutions real executions and maxModelTurns provider calls
   *   happen before the turn is reported as unfinished.
   */
  private async runModelLoop(
    normalized: string,
    options: ModelRequestOptions,
    provider: ModelProvider,
  ): Promise<AgentSnapshot> {
    const maxExecutions = this.options.maxToolExecutions ?? MAX_TOOL_EXECUTIONS
    const maxTurns = this.options.maxModelTurns ?? MAX_MODEL_TURNS
    const deadlineMs = this.options.loopDeadlineMs ?? DEFAULT_LOOP_DEADLINE_MS
    const startedAt = this.monotonicMs()
    const startedWall = this.wallClockIso()
    const session: ModelSession = { messages: [], toolChoice: 'auto' }
    const authContext: ToolAuthorizationContext = { userMessage: normalized }
    let executions = 0
    let successes = 0
    let failures = 0
    let turns = 0
    let requestedToolCalls = 0
    let toolBudgetReached = false
    const startedWithDocumentConsent = this.options.allowDocumentExcerpts?.() ?? false
    let unfinished: { status: AgentTurnStatus; message: string } | undefined

    while (turns < maxTurns) {
      const remaining = deadlineMs - (this.monotonicMs() - startedAt)
      if (remaining <= 0) {
        unfinished = { status: 'deadline_exceeded', message: `本轮请求已超出 ${deadlineMs} 毫秒期限，未能得到最终回答。` }
        break
      }
      turns += 1
      session.timeoutMs = Math.min(remaining, 45_000)

      const documentConsent = this.options.allowDocumentExcerpts?.() ?? false
      if (startedWithDocumentConsent && !documentConsent) {
        const notice = '文献片段发送已关闭，本轮已停止继续调用模型；本地资料仍保留。请重新发送问题。'
        this.store.addMessage('assistant', notice)
        this.setTurn('answered', { toolExecutions: executions, toolSuccesses: successes, toolFailures: failures, modelTurns: turns, requestedToolCalls, toolBudgetReached, startedAt: startedWall })
        this.state = 'READY'
        return this.snapshot()
      }

      let turn: ModelTurn
      try {
        const documentConsent = this.options.allowDocumentExcerpts?.() ?? false
        if (!documentConsent) session.messages = sanitizeModelSession(session.messages)
        const context = this.contextFrame(this.store.workflow(), normalized, documentConsent)
        if (documentConsent && !(this.options.allowDocumentExcerpts?.() ?? false)) {
          const notice = '文献片段发送已关闭，本轮已停止继续调用模型；本地资料仍保留。请重新发送问题。'
          this.store.addMessage('assistant', notice)
          this.setTurn('answered', { toolExecutions: executions, toolSuccesses: successes, toolFailures: failures, modelTurns: turns, requestedToolCalls, toolBudgetReached, startedAt: startedWall })
          this.state = 'READY'
          return this.snapshot()
        }
        turn = await provider.complete(context, this.tools, options, session)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.store.addMessage('assistant', `模型请求失败：${reason}。本轮未执行任何需要审批的提案。`)
        this.setTurn('provider_error', {
          toolExecutions: executions, toolSuccesses: successes, toolFailures: failures, modelTurns: turns, requestedToolCalls, toolBudgetReached,
          startedAt: startedWall, error: reason,
        })
        this.state = 'READY'
        return this.snapshot()
      }

      const calls = normalizeToolCalls(turn)
      if (calls.length === 0) {
        this.store.addMessage('assistant', turn.content || '模型没有返回文字内容。')
        this.setTurn('answered', {
          toolExecutions: executions, toolSuccesses: successes, toolFailures: failures, modelTurns: turns, requestedToolCalls, toolBudgetReached, startedAt: startedWall,
        })
        this.state = 'READY'
        return this.snapshot()
      }
      requestedToolCalls += calls.length

      const assistantToolCalls = calls.map((call, index) => ({
        id: call.id || `call_${turns}_${index}`,
        name: call.name,
        arguments: this.options.allowDocumentExcerpts?.() === false
          ? sanitizeToolArguments(call.rawArguments ?? stringifyArguments(call.arguments))
          : call.rawArguments ?? stringifyArguments(call.arguments),
      }))
      session.messages.push({
        role: 'assistant',
        content: turn.content,
        toolCalls: assistantToolCalls,
        ...(turn.reasoningContent !== undefined ? { reasoningContent: turn.reasoningContent } : {}),
      })

      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index]!
        const reference = assistantToolCalls[index]!
        const tool = this.findTool(call.name)
        let observation: string

        if (!tool) {
          observation = `错误：未知工具 ${call.name}，未执行。`
        } else if (call.argumentsError) {
          observation = `错误：工具 ${call.name} 的参数不是有效 JSON（${call.argumentsError}），未执行。`
        } else {
          const problems = validateToolArguments(toolParameterSchema(tool.name, toolParametersOf(tool)), call.arguments)
          if (problems.length > 0) {
            observation = `错误：工具 ${call.name} 的参数无效（${problems.join('；')}），未执行。`
          } else if (tool.approvalRequired) {
            const staged = this.stageApproval(tool, call, turn.content)
            session.messages.push({
              role: 'tool', toolCallId: reference.id, name: call.name,
              content: `已生成待审批提案「${staged.title}」，未执行任何变更。`,
            })
            this.store.addMessage('assistant', `${staged.summary}\n\n这项操作需要你明确通过，我会在审批前保持工作流不变。`, staged.approval.id)
            this.setTurn('approval_pending', {
              toolExecutions: executions, toolSuccesses: successes, toolFailures: failures, modelTurns: turns, requestedToolCalls, toolBudgetReached, startedAt: startedWall,
            })
            this.state = 'WAITING'
            return this.snapshot()
          } else {
            let refusal: string | undefined
            try {
              refusal = !documentConsentForTool(this.options.allowDocumentExcerpts?.() ?? false, call.name)
                ? `“${call.name}”需要向云端模型提供文献片段，请先在模型设置中开启文献片段发送。`
                : tool.authorize?.(call.arguments, authContext)
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error)
              refusal = `工具 ${call.name} 的授权检查失败（${reason}）`
            }
            if (refusal) {
              observation = `错误：${refusal}`
            } else if (executions >= maxExecutions) {
              toolBudgetReached = true
              observation = `错误：本轮工具执行次数已达到 ${maxExecutions} 次上限，未执行 ${call.name}。`
              session.toolChoice = 'none'
            } else {
              // The budget counts every actual invocation, before calling: a
              // throwing tool may already have produced side effects. Schema
              // rejection, an unknown tool and approval staging are not calls.
              executions += 1
              if (executions >= maxExecutions) toolBudgetReached = true
              try {
                const result = await tool.execute(call.arguments, authContext)
                successes += 1
                const kind = tool.mutatesState === undefined ? '工具' : tool.mutatesState ? '写入工具' : '只读工具'
                this.store.addActivity('message', '工具执行', `${kind} ${tool.name} 已执行`)
                observation = observationContent(result)
                if (!(this.options.allowDocumentExcerpts?.() ?? false) && call.name.startsWith('research_')) {
                  observation = stripDocumentText(observation)
                }
              } catch (error) {
                failures += 1
                const reason = error instanceof Error ? error.message : String(error)
                observation = `错误：工具 ${call.name} 执行失败：${reason}。（该调用可能已产生副作用，请核对当前状态。）`
              }
            }
          }
        }
        if (executions >= maxExecutions) session.toolChoice = 'none'
        session.messages.push({ role: 'tool', toolCallId: reference.id, name: call.name, content: observation })
      }
    }

    const notice = unfinished?.message ?? `本轮模型调用次数已达到 ${maxTurns} 次上限，未能得到最终回答。`
    this.store.addMessage('assistant', notice)
    this.setTurn(unfinished?.status ?? 'budget_exhausted', {
      toolExecutions: executions, toolSuccesses: successes, toolFailures: failures, modelTurns: turns, requestedToolCalls, toolBudgetReached,
      startedAt: startedWall, error: notice,
    })
    this.state = 'READY'
    return this.snapshot()
  }

  private monotonicMs(): number {
    if (this.options.monotonicNow) return this.options.monotonicNow()
    if (this.options.now) return this.options.now().getTime()
    return performance.now()
  }

  private wallClockIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  private setTurn(status: AgentTurnStatus, counters: {
    toolExecutions?: number
    toolSuccesses?: number
    toolFailures?: number
    modelTurns?: number
    requestedToolCalls?: number
    toolBudgetReached?: boolean
    startedAt?: string
    error?: string
  }): void {
    this.turn = {
      status,
      toolExecutions: counters.toolExecutions ?? 0,
      toolSuccesses: counters.toolSuccesses ?? 0,
      toolFailures: counters.toolFailures ?? 0,
      modelTurns: counters.modelTurns ?? 0,
      requestedToolCalls: counters.requestedToolCalls ?? 0,
      toolBudgetReached: counters.toolBudgetReached ?? false,
      maxToolExecutions: this.options.maxToolExecutions ?? MAX_TOOL_EXECUTIONS,
      maxModelTurns: this.options.maxModelTurns ?? MAX_MODEL_TURNS,
      loopDeadlineMs: this.options.loopDeadlineMs ?? DEFAULT_LOOP_DEADLINE_MS,
      startedAt: counters.startedAt ?? this.wallClockIso(),
      finishedAt: this.wallClockIso(),
      ...(counters.error ? { error: counters.error } : {}),
    }
  }

  private findTool(name: string): ToolDefinition<Record<string, unknown>, unknown> | undefined {
    try {
      return this.tools.get(name)
    } catch {
      return undefined
    }
  }

  private stageApproval(
    tool: ToolDefinition<Record<string, unknown>, unknown>,
    call: ModelToolCall,
    content: string,
  ): { approval: ApprovalRequest; title: string; summary: string } {
    const title = approvalTitle(tool.name, call.arguments)
    const summary = content.trim() || `Agent 请求调用 ${tool.name}，执行前需要人工确认。`
    const proposal: ToolProposal = { tool: tool.name, title, summary, payload: call.arguments }
    const approval = this.store.createApproval({ title, summary, tool: tool.name, risk: tool.risk }, proposal)
    this.proposals.set(approval.id, proposal)
    return { approval, title, summary }
  }

  async decide(approvalId: string, decision: 'approve' | 'reject'): Promise<AgentSnapshot> {
    const proposal = this.proposals.get(approvalId) ?? this.store.approvalProposal(approvalId)
    const approval = this.store.approvals().find(item => item.id === approvalId)
    if (!approval) throw new Error('审批不存在。')
    if (decision === 'reject') {
      this.store.transaction(() => this.store.resolveApproval(approvalId, 'REJECTED'))
      this.proposals.delete(approvalId)
      this.store.addMessage('assistant', `已取消：${approval.title}。工作流没有发生变更。`)
      this.state = 'READY'
      return this.snapshot()
    }
    if (!proposal) throw new Error('审批提案已失效，请重新发起。')
    const workflow = this.store.workflow()
    if (workflow.id !== approval.workflowRunId || workflow.status !== 'WAITING_APPROVAL' || workflow.revision !== approval.workflowRevision) {
      throw new Error('审批基于旧的工作流上下文，不能执行；请拒绝后重新发起。')
    }
    const tool = this.tools.get(proposal.tool)
    let result: unknown
    this.store.transaction(() => {
      this.store.resolveApproval(approvalId, 'APPROVED')
      result = this.executeSynchronousTool(proposal.tool, proposal.payload)
    })
    this.proposals.delete(approvalId)
    this.store.addMessage('assistant', this.resultMessage(approval, result))
    this.state = this.store.workflow().status === 'PAUSED' ? 'PAUSED' : 'READY'
    return this.snapshot()
  }

  async wake(): Promise<AgentSnapshot> {
    this.store.transaction(() => {
      this.executeSynchronousTool('workflow_wake', {})
      this.store.addMessage('system', '工作流已由控制台唤醒。')
      this.store.addActivity('wake', '工作流唤醒', '暂停已解除，Agent 恢复待命')
    })
    this.state = 'READY'
    return this.snapshot()
  }

  async checkScheduledWake(at = this.options.now?.() ?? new Date()): Promise<boolean> {
    if (this.waking) return false
    const dueWorkflowRunIds = this.store.dueWorkflowRunIds(at)
    if (dueWorkflowRunIds.length === 0) return false
    this.waking = true
    try {
      const activeWorkflowRunId = this.store.activeWorkflowRunId()
      for (const workflowRunId of dueWorkflowRunIds) this.store.wakeWorkflowRun(workflowRunId)
      if (dueWorkflowRunIds.includes(activeWorkflowRunId)) this.state = 'READY'
      return true
    } finally {
      this.waking = false
    }
  }

  private resultMessage(approval: ApprovalRequest, result: unknown): string {
    const workflow = result as Partial<AgentSnapshot['workflow']>
    if (approval.tool === 'workflow_pause') return `已通过并执行：${approval.title}。我会保持暂停，直到手动或定时唤醒。`
    if (approval.tool === 'workflow_advance') return `已通过并执行：${approval.title}。当前阶段为 ${workflow.currentStage ?? '下一阶段'}。`
    return `已通过并执行：${approval.title}。`
  }

  private executeSynchronousTool(name: string, payload: Record<string, unknown>): unknown {
    const result = this.tools.get(name).execute(payload)
    if (result instanceof Promise) throw new Error(`工具 ${name} 不能在同步事务外提交。`)
    return result
  }

  private contextFrame(workflow = this.store.workflow(), query?: string, documentConsent = this.options.allowDocumentExcerpts?.() ?? false): ModelContextFrame {
    const messages = this.store.messagesForContext()
    const latestUserMessage = [...messages].reverse().find(message => message.role === 'user')
    const memory = documentConsent ? this.store.conversationMemory() : undefined
    const additionalContext = documentConsent ? this.options.additionalContext?.(workflow.id) ?? '' : ''
    const privacyNote = documentConsent ? '' : '\n\n隐私设置：自动文档片段发送已关闭。不要调用需要读取或引用文献正文的工具；只可用来源标识与文献信息回答。用户本次直接输入的内容仍可作为问题上下文。'
    return composeModelContext({
      instructions: `${SYSTEM_PROMPT}${privacyNote}${additionalContext ? `\n\n${additionalContext}` : ''}`,
      workflow,
      conversationId: this.store.activeConversationId(),
      ...(memory ? { memory } : {}),
      evidence: documentConsent ? this.store.searchEvidence(query ?? latestUserMessage?.content ?? '', 6) : [],
      messages: documentConsent ? messages : (latestUserMessage ? [latestUserMessage] : []),
      // Match the provider request: full definitions include the JSON Schema
      // that actually consumes tokens. `risk` is a short extra label only.
      tools: this.tools.definitions(),
      tokenBudget: this.options.contextTokenBudget ?? 6_000,
    })
  }
}

function normalizeToolCalls(turn: ModelTurn): ModelToolCall[] {
  if (turn.toolCalls && turn.toolCalls.length > 0) return turn.toolCalls
  return turn.toolCall ? [turn.toolCall] : []
}

const DOCUMENT_TEXT_FIELDS = new Set(['text', 'abstract', 'snippet', 'evidencequote', 'quote', 'body', 'fulltext', 'content'])
const DOCUMENT_TOOL_BLOCKLIST = new Set(['research_fetch_source', 'research_source_read', 'research_records', 'research_query', 'research_record_add'])

function documentConsentForTool(allowed: boolean, name: string): boolean {
  return allowed || !DOCUMENT_TOOL_BLOCKLIST.has(name)
}

/** Remove excerpt-bearing fields while retaining source identity and citations. */
export function stripDocumentText(serialized: string): string {
  try {
    const parsed: unknown = JSON.parse(serialized)
    const visit = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(visit)
      if (!value || typeof value !== 'object') return value
      const result: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (DOCUMENT_TEXT_FIELDS.has(key.toLowerCase())) continue
        result[key] = visit(child)
      }
      return result
    }
    return JSON.stringify(visit(parsed))
  } catch {
    // Plain validation and execution errors carry no document fields.
    return serialized
  }
}

export function sanitizeToolArguments(serialized: string): string {
  try {
    const parsed = JSON.parse(serialized) as Record<string, unknown>
    const cleaned = { ...parsed }
    for (const key of Object.keys(cleaned)) if (DOCUMENT_TEXT_FIELDS.has(key.toLowerCase())) delete cleaned[key]
    return JSON.stringify(cleaned)
  } catch {
    return '{}'
  }
}

function sanitizeModelSession(messages: ModelSession['messages']): ModelSession['messages'] {
  return messages.map(message => message.role === 'tool'
    ? { ...message, content: stripDocumentText(message.content) }
    : {
      ...message,
      content: '',
      toolCalls: message.toolCalls.map(call => ({ ...call, arguments: sanitizeToolArguments(call.arguments) })),
      ...(message.reasoningContent === undefined ? {} : { reasoningContent: '' }),
    })
}

function approvalTitle(name: string, args: Record<string, unknown>): string {
  if (name === 'workflow_advance') return `推进工作流到 ${String(args.stage ?? '下一阶段')}`
  if (name === 'workflow_pause') return '暂停当前工作流'
  return `调用工具 ${name}`
}

function stringifyArguments(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args) ?? '{}'
  } catch {
    return '{}'
  }
}

function observationContent(result: unknown): string {
  let text: string
  try {
    text = JSON.stringify(result) ?? String(result)
  } catch {
    text = String(result)
  }
  return text.length > MAX_OBSERVATION_CHARS
    ? `${text.slice(0, MAX_OBSERVATION_CHARS)}…（工具结果已按上限截断）`
    : text
}

/**
 * Minimal structural validation of model-supplied arguments against the tool's
 * declared JSON schema (required keys, primitive types, enums and — for named
 * schemas — unknown keys when `additionalProperties` is false). Genuinely
 * invalid calls are reported back to the model instead of executed.
 */
function validateToolArguments(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const problems: string[] = []
  const required = schema.required
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === 'string' && (args[key] === undefined || args[key] === null)) problems.push(`缺少必填参数 ${key}`)
    }
  }
  const properties = schema.properties
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, rawSpec] of Object.entries(properties)) {
      const value = args[key]
      if (value === undefined || value === null) continue
      if (!rawSpec || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) continue
      const spec = rawSpec as Record<string, unknown>
      if (typeof spec.type === 'string' && !matchesJsonType(value, spec.type)) problems.push(`参数 ${key} 类型应为 ${spec.type}`)
      if (Array.isArray(spec.enum) && !spec.enum.some(item => item === value)) problems.push(`参数 ${key} 取值不在允许范围内`)
    }
    // Only enforce `additionalProperties: false` for schemas that actually name
    // fields; the empty fallback schema must not reject every argument.
    if (schema.additionalProperties === false && Object.keys(properties).length > 0) {
      for (const key of Object.keys(args)) {
        if (!(key in properties)) problems.push(`参数 ${key} 不在允许的字段内`)
      }
    }
  }
  return problems
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'null': return value === null
    default: return true
  }
}
