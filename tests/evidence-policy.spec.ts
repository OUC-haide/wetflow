import { describe, expect, it } from 'vitest'
import { EVIDENCE_RESPONSE_POLICY } from '../src/agent/evidence-policy.js'
import { composeModelContext, estimateTokens } from '../src/agent/context.js'
import type {
  ChatMessage,
  ConversationMemory,
  EvidenceChunk,
  WorkflowSnapshot,
} from '../src/core/types.js'

/**
 * Focused structural tests for the evidence response policy and for the
 * context budget rules that keep the newest user instruction and the
 * evidence citations intact.
 *
 * These tests assert *structure and budget behaviour only*. They do not and
 * cannot guarantee that a model answers correctly or that a citation truly
 * supports a claim; they only pin the prompt constraints we export and the
 * context invariants the composer must uphold.
 */

const workflow: WorkflowSnapshot = {
  id: 'wf-evidence',
  projectId: 'project-evidence',
  name: '证据策略测试',
  project: 'WetFlow',
  revision: 3,
  currentStage: 'DESIGN_REVIEW',
  status: 'RUNNING',
  updatedAt: '2026-09-23T00:00:00.000Z',
  completedStages: ['DRAFT'],
}

const tools = [{ name: 'workflow_status', description: '读取状态', approvalRequired: false }]

function fixedTokens(instructions: string): number {
  return estimateTokens(instructions)
    + estimateTokens(JSON.stringify(workflow))
    + estimateTokens(JSON.stringify(tools))
}

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, createdAt: '2026-09-23T00:00:00.000Z' }
}

function chunk(index: number, content: string, citation?: string): EvidenceChunk {
  return {
    id: `chunk-${index}`,
    sourceId: `source-${index}`,
    sourceName: `source-${index}.csv`,
    ordinal: index,
    content,
    citation: citation ?? `[ev:source-${index}#${index}]`,
    score: 10 - index,
  }
}

describe('EVIDENCE_RESPONSE_POLICY prompt constraints', () => {
  it('is a non-empty prompt fragment covering the required concept groups', () => {
    expect(typeof EVIDENCE_RESPONSE_POLICY).toBe('string')
    expect(EVIDENCE_RESPONSE_POLICY.trim().length).toBeGreaterThan(200)
    for (const concept of [
      '首行', '标签', '未知', 'citation', '逐字', '原语言',
      '测量', '推断', '已执行', '提案', '不可信', '不执行', '模板',
    ]) {
      expect(EVIDENCE_RESPONSE_POLICY).toContain(concept)
    }
  })

  it('defers to the user explicit format instead of forcing one template', () => {
    expect(EVIDENCE_RESPONSE_POLICY).toContain('用户')
    expect(EVIDENCE_RESPONSE_POLICY).toContain('固定模板')
    // No baked-in answer skeleton.
    expect(EVIDENCE_RESPONSE_POLICY).not.toContain('```')
    expect(EVIDENCE_RESPONSE_POLICY).not.toContain('输出以下')
  })

  it('does not hardcode benchmark labels, task numbers or sample values', () => {
    expect(EVIDENCE_RESPONSE_POLICY).not.toMatch(/第\s*\d+\s*题/)
    expect(EVIDENCE_RESPONSE_POLICY).not.toMatch(/[A-H]\d{1,2}\s*(mg|µg|mL|%)/i)
    expect(EVIDENCE_RESPONSE_POLICY).not.toMatch(/\d+(\.\d+)?\s*(mg\/L|µg\/L|mg|mL|g\/L)/i)
  })

  it('does not promise the model is always correct', () => {
    expect(EVIDENCE_RESPONSE_POLICY).toContain('不声称')
    expect(EVIDENCE_RESPONSE_POLICY).not.toContain('一定正确')
    expect(EVIDENCE_RESPONSE_POLICY).not.toContain('保证正确')
  })
})

describe('context budget keeps the newest user instruction', () => {
  it('does not let a large evidence block crowd out the latest request', () => {
    const instructions = 'WetFlow evidence prompt'
    const remaining = 1000
    const latestContent = `REQUEST:比较这批数据\n${'x'.repeat(1200)}`
    const context = composeModelContext({
      instructions,
      workflow,
      conversationId: 'chat-evidence-budget',
      evidence: [
        chunk(0, 'e'.repeat(700)),
        chunk(1, 'e'.repeat(700)),
        chunk(2, 'e'.repeat(700)),
        chunk(3, 'e'.repeat(700)),
        chunk(4, 'e'.repeat(700)),
      ],
      messages: [message('msg-latest', 'user', latestContent)],
      tools,
      tokenBudget: fixedTokens(instructions) + remaining,
    })

    const evidenceSource = context.stats.sources.find(source => source.kind === 'evidence')
    const conversationSource = context.stats.sources.find(source => source.kind === 'conversation')
    expect(evidenceSource?.estimatedTokens ?? 0).toBeLessThanOrEqual(remaining * 0.5)
    expect(conversationSource?.estimatedTokens ?? 0).toBeGreaterThanOrEqual(estimateTokens(latestContent))
    expect(context.messages).toHaveLength(1)
    expect(context.messages[0]?.content).toBe(latestContent)
    expect(context.messages[0]?.content).not.toContain('截断')
    expect(estimateTokens(latestContent)).toBeGreaterThan(128)
    expect(context.stats.estimatedTokens).toBeLessThanOrEqual(fixedTokens(instructions) + remaining)
  })

  it('does not let durable memory crowd out the latest request', () => {
    const instructions = 'WetFlow evidence prompt'
    const remaining = 1000
    const latestContent = `REQUEST:核对记录\n${'y'.repeat(1200)}`
    const memory: ConversationMemory = {
      conversationId: 'chat-memory-budget',
      messageCount: 40,
      content: '长期记忆：'.repeat(400),
      updatedAt: '2026-09-23T00:00:00.000Z',
    }
    const context = composeModelContext({
      instructions,
      workflow,
      conversationId: 'chat-memory-budget',
      memory,
      messages: [message('msg-latest', 'user', latestContent)],
      tools,
      tokenBudget: fixedTokens(instructions) + remaining,
    })

    expect(context.messages[0]?.content).toBe(latestContent)
    const memorySource = context.stats.sources.find(source => source.kind === 'memory')
    expect(memorySource?.estimatedTokens ?? 0).toBeLessThanOrEqual(200)
    expect(context.stats.estimatedTokens).toBeLessThanOrEqual(fixedTokens(instructions) + remaining)
  })

  it('still keeps the latest turn when the remaining budget is tiny', () => {
    const instructions = 'WetFlow'
    const remaining = 20
    const context = composeModelContext({
      instructions,
      workflow,
      conversationId: 'chat-tiny',
      messages: [
        message('msg-old', 'assistant', 'old'.repeat(500)),
        message('msg-latest', 'user', 'z'.repeat(4000)),
      ],
      tools,
      tokenBudget: fixedTokens(instructions) + remaining,
    })

    expect(context.messages).toHaveLength(1)
    expect(context.messages[0]?.id).toBe('msg-latest')
    expect(context.messages[0]?.content).toContain('截断')
    expect(context.stats.estimatedTokens).toBeLessThanOrEqual(fixedTokens(instructions) + remaining)
  })

  it('selects a contiguous newest-first window of turns', () => {
    const instructions = 'WetFlow'
    const messages = Array.from({ length: 20 }, (_, index) =>
      message(`msg-${index}`, index % 2 === 0 ? 'user' : 'assistant', `turn ${index} ${'m'.repeat(200)}`))
    const context = composeModelContext({
      instructions,
      workflow,
      conversationId: 'chat-window',
      messages,
      tools,
      tokenBudget: 600,
    })

    const ids = context.messages.map(item => Number(item.id.replace('msg-', '')))
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.at(-1)).toBe(19)
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]).toBe((ids[index - 1] ?? -1) + 1)
    }
  })
})

describe('context preserves evidence citations as structured data', () => {
  it('keeps citation, sourceId and sourceName when an evidence chunk is truncated', () => {
    const instructions = 'WetFlow evidence prompt'
    const remaining = 300
    const original: EvidenceChunk = {
      id: 'chunk-cited',
      sourceId: 'source-assay',
      sourceName: 'assay.csv',
      ordinal: 12,
      content: 'a'.repeat(4000),
      citation: '[证据: assay.csv#12]',
      score: 9,
    }
    const context = composeModelContext({
      instructions,
      workflow,
      conversationId: 'chat-citation',
      evidence: [original],
      messages: [message('msg-latest', 'user', '引用第 12 段')],
      tools,
      tokenBudget: fixedTokens(instructions) + remaining,
    })

    expect(context.evidence).toHaveLength(1)
    const kept = context.evidence[0]
    expect(kept?.citation).toBe('[证据: assay.csv#12]')
    expect(kept?.sourceId).toBe('source-assay')
    expect(kept?.sourceName).toBe('assay.csv')
    expect(kept?.id).toBe('chunk-cited')
    expect(kept?.ordinal).toBe(12)
    expect(kept?.content.length).toBeLessThan(original.content.length)
    expect(estimateTokens(kept?.content ?? '')).toBeLessThanOrEqual(remaining)
    expect(context.stats).toMatchObject({ evidenceChunks: 1, evidenceSources: 1 })
  })

  it('keeps evidence order and never invents an extra citation', () => {
    const instructions = 'WetFlow evidence prompt'
    const context = composeModelContext({
      instructions,
      workflow,
      conversationId: 'chat-order',
      evidence: [
        chunk(0, 'first passage', '[证据: a.csv#1]'),
        chunk(1, 'second passage', '[证据: b.csv#2]'),
      ],
      messages: [message('msg-latest', 'user', 'compare')],
      tools,
      tokenBudget: fixedTokens(instructions) + 2000,
    })

    expect(context.evidence.map(item => item.citation)).toEqual([
      '[证据: a.csv#1]',
      '[证据: b.csv#2]',
    ])
    expect(context.evidence.map(item => item.content)).toEqual(['first passage', 'second passage'])
  })
})
