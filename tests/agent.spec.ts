import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WetFlowAgent } from '../src/agent/runtime.js'
import type { ModelContextFrame } from '../src/agent/context.js'
import type { ModelProvider, ModelRequestOptions } from '../src/agent/provider.js'
import { WetFlowStore } from '../src/core/store.js'
import { createWetFlowContext } from '../src/cordis.js'

const temporary: string[] = []

function fixture(): { dir: string; store: WetFlowStore; agent: WetFlowAgent } {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-cordis-'))
  temporary.push(dir)
  const store = new WetFlowStore(join(dir, 'wetflow.db'))
  return { dir, store, agent: new WetFlowAgent(store) }
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('WetFlowAgent approval boundary', () => {
  it('isolates conversations, approvals, and workflow state between runs', async () => {
    const { store, agent } = fixture()
    const firstRunId = store.workflow().id
    const firstConversationId = store.activeConversationId()
    const first = await agent.chat('推进到下一步')
    expect(first.approvals.some(item => item.status === 'PENDING')).toBe(true)

    const second = agent.newWorkflowRun('第二轮验证')
    const secondRunId = second.workflow.id
    expect(secondRunId).not.toBe(firstRunId)
    expect(second.workflow.currentStage).toBe('DRAFT')
    expect(second.messages).toEqual([])
    expect(second.approvals).toEqual([])
    const secondStaged = await agent.chat('推进到下一步')
    expect(secondStaged.approvals.some(item => item.status === 'PENDING')).toBe(true)

    const restored = agent.switchWorkflowRun(firstRunId)
    expect(restored.context.workflowId).toBe(firstRunId)
    expect(restored.context.conversationId).toBe(firstConversationId)
    expect(restored.workflow.currentStage).toBe('DESIGN_REVIEW')
    expect(restored.approvals).toHaveLength(1)
    expect(restored.approvals[0]).toMatchObject({ workflowRunId: firstRunId, status: 'PENDING' })
    expect(restored.messages.some(message => message.content === '推进到下一步')).toBe(true)
    agent.dispose()
    store.close()
  })

  it('persists a recomputable long-term memory for older conversation turns', () => {
    const { dir, store, agent } = fixture()
    agent.newConversation()
    for (let index = 0; index < 12; index += 1) {
      store.addMessage(index % 2 === 0 ? 'user' : 'assistant', `记忆测试消息 ${index}：${'上下文'.repeat(20)}`)
    }
    const memory = store.conversationMemory(4)
    expect(memory).toMatchObject({ messageCount: 8 })
    expect(memory?.content).toContain('记忆测试消息 0')
    expect(memory?.throughMessageId).toBeDefined()
    agent.dispose()
    store.close()

    const restoredStore = new WetFlowStore(join(dir, 'wetflow.db'))
    const restored = restoredStore.conversationMemory(4)
    expect(restored).toEqual(memory)
    restoredStore.close()
  })

  it('retrieves cited local evidence only inside its owning workflow run', async () => {
    const { store, agent } = fixture()
    const firstRunId = store.workflow().id
    const source = store.addEvidenceSource(
      'assay-results.csv',
      'strain,condition,pyc_mg_l\nA07,glucose,12.4\nA07,glycerol,8.1\n结论：葡萄糖条件下 PYC 检测值最高。',
      'text/csv',
    )
    expect(source.chunkCount).toBe(1)
    expect(store.searchEvidence('葡萄糖 PYC 检测值')).toEqual([
      expect.objectContaining({ sourceId: source.id, citation: '[证据: assay-results.csv#1]' }),
    ])

    agent.newWorkflowRun('隔离证据运行')
    expect(store.evidenceSources()).toEqual([])
    expect(store.searchEvidence('葡萄糖 PYC 检测值')).toEqual([])

    agent.switchWorkflowRun(firstRunId)
    const answer = await agent.chat('根据资料查找葡萄糖条件下的 PYC 检测结果')
    expect(answer.messages.at(-1)?.content).toContain('[证据: assay-results.csv#1]')
    expect(answer.context).toMatchObject({ evidenceSources: 1, evidenceChunks: 1 })
    agent.dispose()
    store.close()
  })

  it('rewinds a user turn and generates a replacement response', async () => {
    const { store, agent } = fixture()
    const staged = await agent.chat('推进到下一步')
    const userMessage = staged.messages.find(message => message.role === 'user' && message.content === '推进到下一步')
    expect(staged.approvals.some(item => item.status === 'PENDING')).toBe(true)

    const retried = await agent.editMessage(userMessage?.id ?? '', '检查当前状态')
    expect(retried.messages.find(message => message.id === userMessage?.id)?.content).toBe('检查当前状态')
    expect(retried.messages.at(-1)?.role).toBe('assistant')
    expect(retried.messages.at(-1)?.content).toContain('当前工作流')
    expect(retried.approvals.some(item => item.status === 'PENDING')).toBe(false)
    expect(retried.workflow).toMatchObject({ currentStage: 'DESIGN_REVIEW', status: 'RUNNING' })
    agent.dispose()
    store.close()
  })

  it('refuses to rewind across an executed workflow state change', async () => {
    const { store, agent } = fixture()
    const staged = await agent.chat('推进到下一步')
    const userMessage = staged.messages.find(message => message.role === 'user')
    const approval = staged.approvals.find(item => item.status === 'PENDING')
    await agent.decide(approval?.id ?? '', 'approve')

    await expect(agent.editMessage(userMessage?.id ?? '', '检查当前状态')).rejects.toThrow('工作流状态已经发生变更')
    expect(agent.snapshot().workflow.currentStage).toBe('DESIGN_APPROVED')
    agent.dispose()
    store.close()
  })

  it('starts a new conversation without resetting workflow state or deleting history', async () => {
    const { store, agent } = fixture()
    const originalConversationId = store.activeConversationId()
    await agent.chat('检查当前状态')
    const stageBefore = agent.snapshot().workflow.currentStage
    const originalMessages = agent.snapshot().messages

    const fresh = agent.newConversation()
    expect(fresh.messages).toEqual([])
    expect(fresh.workflow.currentStage).toBe(stageBefore)
    expect(store.conversations()).toHaveLength(2)

    const restored = agent.switchConversation(originalConversationId)
    expect(restored.messages).toEqual(originalMessages)
    expect(restored.workflow.currentStage).toBe(stageBefore)
    agent.dispose()
    store.close()
  })

  it('forwards the selected model and reasoning effort to the configured provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-model-options-'))
    temporary.push(dir)
    const store = new WetFlowStore(join(dir, 'wetflow.db'))
    let received: ModelRequestOptions | undefined
    let receivedContext: ModelContextFrame | undefined
    const provider: ModelProvider = {
      defaultModel: () => 'model-a',
      models: async () => [{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }],
      complete: async (context, _tools, options) => {
        receivedContext = context
        received = options
        return { content: '模型响应完成。' }
      },
    }
    const agent = new WetFlowAgent(store, provider)
    await agent.chat('分析当前状态', { model: 'model-b', reasoningEffort: 'high' })
    expect(received).toEqual({ model: 'model-b', reasoningEffort: 'high' })
    expect(receivedContext?.stats).toMatchObject({
      workflowId: 'wf-demo',
      selectedMessages: 2,
      totalMessages: 2,
    })
    expect(await agent.modelOptions()).toMatchObject({
      enabled: true,
      defaultModel: 'model-a',
      models: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'builtin' }],
    })
    received = undefined
    await agent.chat('使用内置规则检查状态', { model: 'builtin', reasoningEffort: 'high' })
    expect(received).toBeUndefined()
    agent.dispose()
    store.close()
  })

  it('stages a transition and changes no workflow state before approval', async () => {
    const { store, agent } = fixture()
    const before = store.workflow()
    const staged = await agent.chat('推进到下一步')
    expect(staged.workflow.currentStage).toBe(before.currentStage)
    expect(staged.workflow.status).toBe('WAITING_APPROVAL')
    const approval = staged.approvals.find(item => item.status === 'PENDING')
    expect(approval).toMatchObject({
      tool: 'workflow_advance',
      risk: 'HIGH',
      conversationId: store.activeConversationId(),
      workflowRevision: staged.workflow.revision,
    })

    const committed = await agent.decide(approval?.id ?? '', 'approve')
    expect(committed.workflow.currentStage).toBe('DESIGN_APPROVED')
    expect(committed.workflow.completedStages).toEqual(['DRAFT', 'DESIGN_REVIEW'])
    expect(committed.approvals[0]?.status).toBe('APPROVED')
    agent.dispose()
    store.close()
  })

  it('rejects a proposal without changing the stage', async () => {
    const { store, agent } = fixture()
    const staged = await agent.chat('推进到下一步')
    const approval = staged.approvals.find(item => item.status === 'PENDING')
    const rejected = await agent.decide(approval?.id ?? '', 'reject')
    expect(rejected.workflow.currentStage).toBe('DESIGN_REVIEW')
    expect(rejected.workflow.status).toBe('RUNNING')
    expect(rejected.messages.at(-1)?.content).toContain('工作流没有发生变更')
    agent.dispose()
    store.close()
  })

  it('pauses only after approval and wakes without another approval', async () => {
    const { store, agent } = fixture()
    const staged = await agent.chat('暂停一小时')
    expect(staged.workflow.status).toBe('WAITING_APPROVAL')
    const approval = staged.approvals.find(item => item.status === 'PENDING')
    const paused = await agent.decide(approval?.id ?? '', 'approve')
    expect(paused.workflow.status).toBe('PAUSED')
    expect(paused.workflow.wakeAt).toBeDefined()
    const awake = await agent.wake()
    expect(awake.workflow.status).toBe('RUNNING')
    expect(awake.workflow.wakeAt).toBeUndefined()
    expect(awake.workflow.pauseReason).toBeUndefined()
    agent.dispose()
    store.close()
  })

  it('starts a relative pause countdown when approval executes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-cordis-relative-pause-'))
    temporary.push(dir)
    const store = new WetFlowStore(join(dir, 'wetflow.db'))
    let now = new Date('2026-08-12T08:00:00.000Z')
    const agent = new WetFlowAgent(store, undefined, { now: () => now })
    const staged = await agent.chat('暂停 2 秒')
    const approvalId = staged.approvals.find(item => item.status === 'PENDING')?.id ?? ''
    now = new Date('2026-08-12T08:01:00.000Z')

    const paused = await agent.decide(approvalId, 'approve')
    expect(paused.workflow.wakeAt).toBe('2026-08-12T08:01:02.000Z')
    agent.dispose()
    store.close()
  })

  it('restores a pending proposal after a full agent and database restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-cordis-restart-'))
    temporary.push(dir)
    const path = join(dir, 'wetflow.db')
    const firstStore = new WetFlowStore(path)
    const firstAgent = new WetFlowAgent(firstStore)
    const staged = await firstAgent.chat('推进到下一步')
    const approvalId = staged.approvals.find(item => item.status === 'PENDING')?.id ?? ''
    firstAgent.dispose()
    firstStore.close()

    const secondStore = new WetFlowStore(path)
    const secondAgent = new WetFlowAgent(secondStore)
    const committed = await secondAgent.decide(approvalId, 'approve')
    expect(committed.workflow.currentStage).toBe('DESIGN_APPROVED')
    expect(committed.approvals.find(item => item.id === approvalId)?.status).toBe('APPROVED')
    secondAgent.dispose()
    secondStore.close()
  })

  it('automatically wakes a paused workflow when its durable time arrives', async () => {
    const { store, agent: original } = fixture()
    original.dispose()
    store.setWorkflow({
      status: 'PAUSED',
      pauseReason: '等待培养完成',
      wakeAt: new Date(Date.now() + 30).toISOString(),
    })
    const agent = new WetFlowAgent(store, undefined, { wakePollMs: 5 })
    await expect.poll(() => agent.snapshot().workflow.status, { timeout: 1_000 }).toBe('RUNNING')
    expect(agent.snapshot().messages.at(-1)?.content).toContain('自动唤醒')
    expect(agent.snapshot().activity.some(item => item.label === '定时自动唤醒')).toBe(true)
    agent.dispose()
    store.close()
  })

  it('automatically wakes a due run even while another run is active', async () => {
    const { store, agent } = fixture()
    const pausedRunId = store.workflow().id
    store.setWorkflow({
      status: 'PAUSED',
      pauseReason: '等待离线运行',
      wakeAt: '2099-01-01T00:00:00.000Z',
    })
    const active = agent.newWorkflowRun('并行运行')
    expect(active.workflow.id).not.toBe(pausedRunId)

    expect(await agent.checkScheduledWake(new Date('2099-01-01T00:00:01.000Z'))).toBe(true)
    expect(agent.snapshot().workflow.id).toBe(active.workflow.id)
    const restored = agent.switchWorkflowRun(pausedRunId)
    expect(restored.workflow.status).toBe('RUNNING')
    expect(restored.messages.at(-1)?.content).toContain('自动唤醒')
    expect(restored.activity.some(item => item.label === '定时自动唤醒')).toBe(true)
    agent.dispose()
    store.close()
  })

  it('rolls an approval back when the approved tool cannot execute', async () => {
    const { store, agent } = fixture()
    const proposal = {
      tool: 'workflow_advance',
      title: '非法跳步',
      summary: '尝试直接跳到种子制备。',
      payload: { stage: 'SEED_PREPARATION' },
    }
    const approval = store.createApproval({
      title: proposal.title, summary: proposal.summary, tool: proposal.tool, risk: 'HIGH',
    }, proposal)
    await expect(agent.decide(approval.id, 'approve')).rejects.toThrow('只能从 DESIGN_REVIEW 前进到下一阶段')
    expect(store.approvals().find(item => item.id === approval.id)?.status).toBe('PENDING')
    expect(store.workflow()).toMatchObject({ currentStage: 'DESIGN_REVIEW', status: 'WAITING_APPROVAL' })
    agent.dispose()
    store.close()
  })

  it('refuses to execute an approval after its workflow context becomes stale', async () => {
    const { store, agent } = fixture()
    const staged = await agent.chat('推进到下一步')
    const approvalId = staged.approvals.find(item => item.status === 'PENDING')?.id ?? ''
    const stagedRevision = staged.workflow.revision

    const changed = await agent.wake()
    expect(changed.workflow.revision).toBeGreaterThan(stagedRevision)
    await expect(agent.decide(approvalId, 'approve')).rejects.toThrow('审批基于旧的工作流上下文')
    expect(store.workflow().currentStage).toBe('DESIGN_REVIEW')

    const rejected = await agent.decide(approvalId, 'reject')
    expect(rejected.approvals.find(item => item.id === approvalId)?.status).toBe('REJECTED')
    expect(rejected.workflow.currentStage).toBe('DESIGN_REVIEW')
    agent.dispose()
    store.close()
  })
})

describe('WetFlowStore workspace migration', () => {
  it('adopts a legacy single-run database without losing its context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-legacy-workspace-'))
    temporary.push(dir)
    const path = join(dir, 'wetflow.db')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, project TEXT NOT NULL, current_stage TEXT NOT NULL,
        status TEXT NOT NULL, wake_at TEXT, pause_reason TEXT, completed_stages TEXT NOT NULL,
        updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, approval_id TEXT,
        created_at TEXT NOT NULL, conversation_id TEXT
      );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, tool TEXT NOT NULL,
        risk TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT,
        proposal_json TEXT, conversation_id TEXT, workflow_revision INTEGER
      );
      CREATE TABLE activity (id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX idx_approvals_single_pending ON approvals(status) WHERE status = 'PENDING';
      INSERT INTO workflow_runs VALUES ('wf-legacy', '旧实验', '旧项目', 'ASSAY', 'WAITING_APPROVAL', NULL, NULL, '["DRAFT"]', '2026-08-01T00:00:00.000Z', 7);
      INSERT INTO conversations VALUES ('chat-legacy', '旧对话', '2026-08-01T00:00:00.000Z', '2026-08-01T00:02:00.000Z');
      INSERT INTO app_state VALUES ('active_conversation_id', 'chat-legacy');
      INSERT INTO messages VALUES ('msg-legacy', 'user', '保留这条历史消息', 'approval-legacy', '2026-08-01T00:01:00.000Z', 'chat-legacy');
      INSERT INTO approvals VALUES ('approval-legacy', '旧审批', '等待确认', 'workflow_advance', 'HIGH', 'PENDING', '2026-08-01T00:02:00.000Z', NULL, '{"tool":"workflow_advance","title":"旧审批","summary":"等待确认","payload":{"stage":"ANALYSIS"}}', 'chat-legacy', 7);
      INSERT INTO activity VALUES ('event-legacy', 'approval', '等待审批', '旧审批', '2026-08-01T00:02:00.000Z');
    `)
    legacy.close()

    const store = new WetFlowStore(path)
    const workflow = store.workflow()
    expect(workflow).toMatchObject({ id: 'wf-legacy', project: '旧项目', currentStage: 'ASSAY', revision: 7 })
    expect(store.workspace()).toMatchObject({
      activeProjectId: workflow.projectId,
      activeWorkflowRunId: 'wf-legacy',
      projects: [{ name: '旧项目', runCount: 1 }],
      runs: [{ id: 'wf-legacy', projectId: workflow.projectId }],
    })
    expect(store.conversations()).toEqual([
      expect.objectContaining({ id: 'chat-legacy', workflowRunId: 'wf-legacy', title: '旧对话' }),
    ])
    expect(store.messages()[0]?.content).toBe('保留这条历史消息')
    expect(store.approvals()[0]).toMatchObject({ id: 'approval-legacy', workflowRunId: 'wf-legacy', conversationId: 'chat-legacy' })
    expect(store.activity()[0]?.id).toBe('event-legacy')
    store.close()
  })
})

describe('Cordis composition', () => {
  it('mounts the standalone agent as a Cordis service and disposes its database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-cordis-context-'))
    temporary.push(dir)
    const ctx = await createWetFlowContext({ dbPath: join(dir, 'wetflow.db') })
    expect(ctx.wetflow.snapshot().connected).toBe(true)
    expect(ctx.wetflow.tools.list().map(tool => tool.name)).toEqual([
      'workflow_status', 'workflow_advance', 'workflow_pause', 'workflow_wake',
    ])
    await ctx.fiber.dispose()
  })
})
