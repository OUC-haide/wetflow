import type {
  ChatMessage,
  ContextSourceStats,
  ContextWindowStats,
  ConversationMemory,
  EvidenceChunk,
  WorkflowSnapshot,
} from '../core/types.js'

export interface ContextTool {
  name: string
  description: string
  approvalRequired: boolean
}

export interface ModelContextFrame {
  instructions: string
  workflow: WorkflowSnapshot
  memory?: ConversationMemory
  evidence: EvidenceChunk[]
  messages: ChatMessage[]
  tools: ContextTool[]
  stats: ContextWindowStats
}

export interface ComposeModelContextOptions {
  instructions: string
  workflow: WorkflowSnapshot
  conversationId: string
  memory?: ConversationMemory
  evidence?: EvidenceChunk[]
  messages: ChatMessage[]
  tools: ContextTool[]
  tokenBudget: number
  generatedAt?: string
}

const NON_ASCII_TOKEN_WEIGHT = 2 / 3
// Never let auxiliary blocks (memory/evidence) reduce the conversation share
// below this floor, and prefer reserving at least half of what is left so the
// user's latest instruction survives heavy evidence retrieval.
const MIN_MESSAGE_TOKENS = 128

export function estimateTokens(value: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii * NON_ASCII_TOKEN_WEIGHT))
}

function truncateToTokenBudget(value: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return ''
  if (estimateTokens(value) <= tokenBudget) return value
  const fullSuffix = '\n…（较早内容已按上下文预算截断）'
  const suffix = estimateTokens(fullSuffix) <= tokenBudget ? fullSuffix : ''
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(`${value.slice(0, middle)}${suffix}`) <= tokenBudget) low = middle
    else high = middle - 1
  }
  return `${value.slice(0, low)}${suffix}`
}

export function composeModelContext(options: ComposeModelContextOptions): ModelContextFrame {
  const messages = options.messages.filter(message => message.role !== 'system')
  const throughIndex = options.memory?.throughMessageId
    ? messages.findIndex(message => message.id === options.memory?.throughMessageId)
    : -1
  const candidateMessages = throughIndex >= 0 ? messages.slice(throughIndex + 1) : messages
  const instructionTokens = estimateTokens(options.instructions)
  const workflowTokens = estimateTokens(JSON.stringify(options.workflow))
  const toolTokens = estimateTokens(JSON.stringify(options.tools))
  const fixedTokens = instructionTokens + workflowTokens + toolTokens
  const remainingAfterFixed = Math.max(0, options.tokenBudget - fixedTokens)
  // Reserve conversation budget before memory/evidence so a long retrieval
  // block cannot crowd out the newest user instruction (which carries the
  // explicit format/label request). Older turns still fill whatever remains.
  const reservedMessageTokens = remainingAfterFixed > 0
    ? Math.min(remainingAfterFixed, Math.max(MIN_MESSAGE_TOKENS, Math.floor(remainingAfterFixed * 0.5)))
    : 0
  const auxiliaryBudget = Math.max(0, remainingAfterFixed - reservedMessageTokens)

  let memory = options.memory
  let memoryTokens = 0
  if (memory && auxiliaryBudget > 0) {
    const memoryBudget = Math.min(600, Math.max(1, Math.floor(auxiliaryBudget * 0.4)))
    const content = truncateToTokenBudget(memory.content, memoryBudget)
    memory = { ...memory, content }
    memoryTokens = estimateTokens(content)
  } else {
    memory = undefined
  }

  const evidenceBudget = Math.max(0, remainingAfterFixed - reservedMessageTokens - memoryTokens)
  const evidence: EvidenceChunk[] = []
  let evidenceTokens = 0
  for (const chunk of options.evidence ?? []) {
    const remaining = evidenceBudget - evidenceTokens
    if (remaining <= 0) break
    const formatted = `${chunk.citation}\n${chunk.content}`
    const chunkTokens = estimateTokens(formatted)
    if (chunkTokens <= remaining) {
      evidence.push(chunk)
      evidenceTokens += chunkTokens
      continue
    }
    if (evidence.length === 0) {
      const citationTokens = estimateTokens(`${chunk.citation}\n`)
      if (remaining > citationTokens) {
        const content = truncateToTokenBudget(chunk.content, remaining - citationTokens)
        evidence.push({ ...chunk, content })
        evidenceTokens += estimateTokens(`${chunk.citation}\n${content}`)
      }
    }
    break
  }

  const messageBudget = Math.max(0, remainingAfterFixed - memoryTokens - evidenceTokens)
  const selected: ChatMessage[] = []
  let selectedTokens = 0

  for (let index = candidateMessages.length - 1; index >= 0; index -= 1) {
    const message = candidateMessages[index]
    if (!message) continue
    const messageTokens = estimateTokens(message.content)
    const remaining = messageBudget - selectedTokens
    if (messageTokens <= remaining) {
      selected.unshift(message)
      selectedTokens += messageTokens
      continue
    }
    if (selected.length === 0 && remaining > 0) {
      const content = truncateToTokenBudget(message.content, remaining)
      selected.unshift({ ...message, content })
      selectedTokens += estimateTokens(content)
    }
    break
  }

  const sources: ContextSourceStats[] = [
    { kind: 'instructions', items: 1, estimatedTokens: instructionTokens },
    { kind: 'workflow', items: 1, estimatedTokens: workflowTokens },
    { kind: 'memory', items: memory ? 1 : 0, estimatedTokens: memoryTokens },
    { kind: 'evidence', items: evidence.length, estimatedTokens: evidenceTokens },
    { kind: 'conversation', items: selected.length, estimatedTokens: selectedTokens },
    { kind: 'tools', items: options.tools.length, estimatedTokens: toolTokens },
  ]
  const stats: ContextWindowStats = {
    projectId: options.workflow.projectId,
    conversationId: options.conversationId,
    workflowId: options.workflow.id,
    workflowRevision: options.workflow.revision,
    tokenBudget: options.tokenBudget,
    estimatedTokens: sources.reduce((sum, source) => sum + source.estimatedTokens, 0),
    memoryMessages: memory?.messageCount ?? 0,
    evidenceSources: new Set(evidence.map(chunk => chunk.sourceId)).size,
    evidenceChunks: evidence.length,
    totalMessages: messages.length,
    selectedMessages: selected.length,
    omittedMessages: messages.length - selected.length,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sources,
  }
  return {
    instructions: options.instructions,
    workflow: options.workflow,
    ...(memory ? { memory } : {}),
    evidence,
    messages: selected,
    tools: options.tools,
    stats,
  }
}
