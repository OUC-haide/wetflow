import { describe, expect, it } from 'vitest'
import { composeModelContext, estimateTokens } from '../src/agent/context.js'
import type { ChatMessage, WorkflowSnapshot } from '../src/core/types.js'

const workflow: WorkflowSnapshot = {
  id: 'wf-context',
  projectId: 'project-context',
  name: '上下文测试',
  project: 'WetFlow',
  revision: 7,
  currentStage: 'DESIGN_REVIEW',
  status: 'RUNNING',
  updatedAt: '2026-08-28T00:00:00.000Z',
  completedStages: ['DRAFT'],
}

function message(index: number, content: string): ChatMessage {
  return {
    id: `msg-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
    createdAt: `2026-08-28T00:00:0${index}.000Z`,
  }
}

describe('model context composition', () => {
  it('keeps the newest complete turns within a shared token budget', () => {
    const messages = Array.from({ length: 6 }, (_, index) => message(index, `${index}:${'a'.repeat(500)}`))
    const context = composeModelContext({
      instructions: 'WetFlow system prompt',
      workflow,
      conversationId: 'chat-active',
      messages,
      tools: [{ name: 'workflow_status', description: '读取状态', approvalRequired: false }],
      tokenBudget: 420,
      generatedAt: '2026-08-28T00:00:10.000Z',
    })

    expect(context.messages.length).toBeGreaterThan(0)
    expect(context.messages.at(-1)?.id).toBe('msg-5')
    expect(context.stats).toMatchObject({
      conversationId: 'chat-active',
      workflowId: 'wf-context',
      workflowRevision: 7,
      totalMessages: 6,
      selectedMessages: context.messages.length,
      omittedMessages: 6 - context.messages.length,
      tokenBudget: 420,
    })
    expect(context.stats.estimatedTokens).toBeLessThanOrEqual(420)
  })

  it('truncates an oversized latest message instead of losing the current turn', () => {
    const context = composeModelContext({
      instructions: 'WetFlow',
      workflow,
      conversationId: 'chat-active',
      messages: [message(0, '较早消息'), message(1, '超长内容'.repeat(2_000))],
      tools: [],
      tokenBudget: 300,
    })

    expect(context.messages).toHaveLength(1)
    expect(context.messages[0]?.id).toBe('msg-1')
    expect(context.messages[0]?.content).toContain('较早内容已按上下文预算截断')
    expect(estimateTokens(context.messages[0]?.content ?? '')).toBeLessThan(300)
    expect(context.stats.omittedMessages).toBe(1)
  })

  it('budgets durable memory and cited evidence before recent conversation turns', () => {
    const messages = Array.from({ length: 12 }, (_, index) => message(index, `第 ${index} 条对话：${'实验信息'.repeat(30)}`))
    const context = composeModelContext({
      instructions: 'WetFlow evidence prompt',
      workflow,
      conversationId: 'chat-memory',
      memory: {
        conversationId: 'chat-memory',
        throughMessageId: 'msg-3',
        messageCount: 4,
        content: '长期记忆：用户要求比较 PYC 来源，Agent 尚未推进工作流。',
        updatedAt: '2026-08-28T00:00:09.000Z',
      },
      evidence: [{
        id: 'chunk-1', sourceId: 'source-1', sourceName: 'assay.csv', ordinal: 0,
        content: 'A07 的 PYC 检测值为 12.4 mg/L。', citation: '[证据: assay.csv#1]', score: 8,
      }],
      messages,
      tools: [{ name: 'workflow_status', description: '读取状态', approvalRequired: false }],
      tokenBudget: 900,
    })

    expect(context.memory?.messageCount).toBe(4)
    expect(context.evidence).toEqual([expect.objectContaining({ citation: '[证据: assay.csv#1]' })])
    expect(context.messages.every(item => Number(item.id.replace('msg-', '')) > 3)).toBe(true)
    expect(context.stats).toMatchObject({ memoryMessages: 4, evidenceSources: 1, evidenceChunks: 1 })
    expect(context.stats.estimatedTokens).toBeLessThanOrEqual(900)
  })
})
