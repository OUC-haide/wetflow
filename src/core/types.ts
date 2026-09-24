export const WORKFLOW_STAGES = [
  { key: 'DRAFT', label: '草稿', description: '定义目标、变量与证据边界' },
  { key: 'DESIGN_REVIEW', label: '设计审核', description: '检查方案与风险' },
  { key: 'DESIGN_APPROVED', label: '设计批准', description: '人工批准后进入执行准备' },
  { key: 'CONSTRUCT_BUILDING', label: '构建制备', description: '生成并记录候选构建' },
  { key: 'PLASMID_VERIFICATION', label: '质粒验证', description: '核验序列与连接区' },
  { key: 'HOST_TRANSFORMATION', label: '宿主转化', description: '人工确认后执行转化' },
  { key: 'STRAIN_VERIFICATION', label: '菌株验证', description: '检查身份、污染和独立克隆' },
  { key: 'SEED_PREPARATION', label: '种子制备', description: '准备可追溯种子批次' },
  { key: 'FERMENTATION', label: '发酵', description: '按已批准参数执行发酵' },
  { key: 'ASSAY', label: '检测', description: '采集仪器原始数据' },
  { key: 'ANALYSIS', label: '分析', description: '执行可复现统计与 QC' },
  { key: 'DECISION', label: '决策', description: '形成下一轮实验建议' },
  { key: 'CLOSED', label: '关闭', description: '经确认后归档项目' },
] as const

export type WorkflowStageKey = typeof WORKFLOW_STAGES[number]['key']
export type WorkflowRunStatus = 'RUNNING' | 'WAITING_APPROVAL' | 'PAUSED' | 'COMPLETED'
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED'
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export interface WorkflowSnapshot {
  id: string
  projectId: string
  name: string
  project: string
  revision: number
  currentStage: WorkflowStageKey
  status: WorkflowRunStatus
  wakeAt?: string
  pauseReason?: string
  updatedAt: string
  completedStages: WorkflowStageKey[]
}

export interface ApprovalRequest {
  id: string
  conversationId: string
  workflowRunId: string
  workflowRevision: number
  title: string
  summary: string
  tool: string
  risk: RiskLevel
  status: ApprovalStatus
  createdAt: string
  resolvedAt?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  approvalId?: string
}

export interface ConversationSummary {
  id: string
  workflowRunId: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface ProjectSummary {
  id: string
  name: string
  runCount: number
  createdAt: string
  updatedAt: string
}

export interface WorkflowRunSummary {
  id: string
  projectId: string
  name: string
  currentStage: WorkflowStageKey
  status: WorkflowRunStatus
  updatedAt: string
}

export interface WorkspaceCatalog {
  activeProjectId: string
  activeWorkflowRunId: string
  projects: ProjectSummary[]
  runs: WorkflowRunSummary[]
}

export interface ActivityEvent {
  id: string
  type: 'message' | 'workflow' | 'approval' | 'wake' | 'evidence'
  label: string
  detail: string
  createdAt: string
}

/**
 * Structured outcome of the most recent user turn. Benchmark hosts read this
 * instead of inferring success from the assistant text: a provider failure,
 * a deadline overrun or a budget stop is a distinct status even though the
 * product still writes a human-readable explanation as the assistant message.
 */
export type AgentTurnStatus =
  | 'answered'
  | 'approval_pending'
  | 'provider_error'
  | 'deadline_exceeded'
  | 'budget_exhausted'

export interface AgentTurnStats {
  status: AgentTurnStatus
  /** Every actual tool.execute invocation, including one that threw. */
  toolExecutions: number
  /** Invocations that returned without throwing. */
  toolSuccesses: number
  /** Invocations that threw (they may already have had side effects). */
  toolFailures: number
  /** Provider calls actually made in this turn. */
  modelTurns: number
  /** Tool calls the model requested, including refused/unknown ones. */
  requestedToolCalls: number
  /** True when at least one requested call was refused because the budget was exhausted. */
  toolBudgetReached: boolean
  maxToolExecutions: number
  maxModelTurns: number
  loopDeadlineMs: number
  startedAt: string
  finishedAt: string
  error?: string
}

export interface AgentSnapshot {
  connected: boolean
  agentState: 'READY' | 'THINKING' | 'WAITING' | 'PAUSED'
  workflow: WorkflowSnapshot
  context: ContextWindowStats
  approvals: ApprovalRequest[]
  messages: ChatMessage[]
  activity: ActivityEvent[]
  tools: Array<{ name: string; description: string; approvalRequired: boolean }>
  /** Structured result of the last user turn, or null before a turn has run. */
  turn: AgentTurnStats | null
}

export interface ContextSourceStats {
  kind: 'instructions' | 'workflow' | 'memory' | 'evidence' | 'conversation' | 'tools'
  items: number
  estimatedTokens: number
}

export interface ContextWindowStats {
  projectId: string
  conversationId: string
  workflowId: string
  workflowRevision: number
  tokenBudget: number
  estimatedTokens: number
  memoryMessages: number
  evidenceSources: number
  evidenceChunks: number
  totalMessages: number
  selectedMessages: number
  omittedMessages: number
  generatedAt: string
  sources: ContextSourceStats[]
}

export interface ConversationMemory {
  conversationId: string
  throughMessageId?: string
  messageCount: number
  content: string
  updatedAt: string
}

export interface EvidenceSource {
  id: string
  workflowRunId: string
  name: string
  mimeType: string
  sizeBytes: number
  chunkCount: number
  createdAt: string
  updatedAt: string
}

export interface EvidenceChunk {
  id: string
  sourceId: string
  sourceName: string
  ordinal: number
  content: string
  citation: string
  score: number
}

/**
 * Context passed to a tool for one execution. `userMessage` is the end user's
 * own message for the current turn; it never contains retrieved evidence,
 * memory or model output, so write tools can require that the value they store
 * was actually requested by the user.
 */
export interface ToolAuthorizationContext {
  userMessage: string
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  approvalRequired: boolean
  risk: RiskLevel
  /**
   * Optional JSON Schema describing the tool input. Providers pass it through as
   * the function `parameters`; tools without a schema keep the legacy fallback.
   */
  parameters?: Record<string, unknown>
  /**
   * True when executing changes persisted state. Used for truthful activity
   * labels and audit; read-only tools must leave the store untouched.
   */
  mutatesState?: boolean
  /**
   * Write authorization boundary. Returns a refusal reason when the model
   * supplied an input the end user did not explicitly request in their own
   * turn (for example a number that only appeared in injected evidence).
   * Refused calls are never executed and are fed back to the model.
   */
  authorize?: (input: TInput, context: ToolAuthorizationContext) => string | undefined
  execute(input: TInput, context?: ToolAuthorizationContext): Promise<TOutput> | TOutput
}

export type AgentEvent =
  | { type: 'snapshot'; snapshot: AgentSnapshot }
  | { type: 'message'; message: ChatMessage }
  | { type: 'workflow'; workflow: WorkflowSnapshot }
  | { type: 'approval'; approval: ApprovalRequest }
  | { type: 'activity'; activity: ActivityEvent }

export interface ToolProposal {
  tool: string
  title: string
  summary: string
  payload: Record<string, unknown>
}
