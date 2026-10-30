import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WetFlowAgent } from '../src/agent/runtime.js'
import type { ModelProvider, ModelTurn } from '../src/agent/provider.js'
import { WetFlowStore } from '../src/core/store.js'
import { registerPlanner } from '../src/plugins/workflow-planner.js'
import { proposedWorkflowStages } from '../src/core/workflow.js'

const dirs: string[] = []
const dispose: Array<() => void> = []
afterEach(() => {
  for (const fn of dispose.splice(0)) fn()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const stages = [
  { key: 'PREPARE', label: '整理资料', description: '核对资料来源和已有实验条件。' },
  { key: 'MEASURE', label: '测量与复核', description: '记录读数并由研究者复核。' },
  { key: 'DISCUSS', label: '讨论结果', description: '比较结果，讨论后续工作。' },
]
function scripted(turns: ModelTurn[]): ModelProvider {
  let index = 0
  return {
    defaultModel: () => 'fixture', models: async () => [{ id: 'fixture', label: 'Fixture' }],
    complete: async () => turns[Math.min(index++, turns.length - 1)]!,
  }
}
const proposal = (input: unknown = stages): ModelTurn => ({
  content: '这是讨论后的路线，请确认。', toolCall: { id: 'plan-call', name: 'workflow_set_plan', arguments: { stages: input } },
})
function setup(provider?: ModelProvider, path?: string, legacy = false) {
  if (!path) { const dir = mkdtempSync(join(tmpdir(), 'wetflow-plan-')); dirs.push(dir); path = join(dir, 'workflow.db') }
  const store = new WetFlowStore(path)
  if (legacy) store.setWorkflow({ currentStage: 'DESIGN_REVIEW', completedStages: ['DRAFT'] })
  store.enableWorkflowPlanning()
  const agent = new WetFlowAgent(store, provider)
  agent.tools.mount('workflow-planner', registry => registerPlanner(registry, store))
  let closed = false
  const close = () => { if (!closed) { closed = true; agent.dispose(); store.close() } }
  dispose.push(close)
  return { store, agent, path, close }
}

describe('collaborative workflow route', () => {
  it('starts the workspace and each new run pending without a preselected route', async () => {
    const { store, agent } = setup()
    expect(store.workflow().plan).toEqual({ status: 'pending', stages: [] })
    expect(store.workflowRuns()[0]?.currentStageLabel).toBe('待定')
    const snapshot = await agent.chat('推进到下一步')
    expect(snapshot.approvals).toEqual([])
    expect(snapshot.messages.at(-1)?.content).toContain('流程待定')
    expect(() => store.advance('DESIGN_REVIEW')).toThrow('流程仍待定')
    expect(agent.newWorkflowRun('自定义流程').workflow.plan).toEqual({ status: 'pending', stages: [] })
  })

  it('shows a complete proposal and only saves the route after approval', async () => {
    const { store, agent } = setup({
      ...scripted([proposal()]),
      complete: async context => {
        expect(context.workflow.plan).toEqual({ status: 'pending', stages: [] })
        expect(context.instructions).toContain('由用户与你共同商讨')
        return proposal()
      },
    })
    const before = store.workflow()
    const pending = await agent.chat('按我们讨论的阶段生成流程')
    expect(pending.workflow.currentStage).toBe(before.currentStage)
    expect(pending.workflow.plan?.status).toBe('pending')
    const approval = pending.approvals[0]!
    for (const stage of stages) expect(approval.summary).toContain(`${stage.label}：${stage.description}`)
    expect(approval.summary).toContain('归档')
    const confirmed = await agent.decide(approval.id, 'approve')
    expect(confirmed.workflow.currentStage).toBe('PREPARE')
    expect(confirmed.workflow.plan?.stages.map(stage => stage.key)).toEqual(['PREPARE', 'MEASURE', 'DISCUSS', 'CLOSED'])
    expect(confirmed.workflow.completedStages).toEqual([])
    expect(confirmed.workflow.plan?.status).toBe('confirmed')
  })

  it('advances only along the confirmed route with separate approvals, including closure', async () => {
    const { store, agent } = setup(scripted([proposal()]))
    const pending = await agent.chat('请生成流程')
    await agent.decide(pending.approvals[0]!.id, 'approve')
    agent.setProvider(undefined)
    expect(() => store.advance('DISCUSS')).toThrow('只能从 PREPARE')
    for (const key of ['MEASURE', 'DISCUSS', 'CLOSED']) {
      const before = store.workflow().currentStage
      const staged = await agent.chat('推进到下一步', { model: 'builtin' })
      expect(staged.workflow.currentStage).toBe(before)
      const approval = staged.approvals.find(item => item.status === 'PENDING')!
      const accepted = await agent.decide(approval.id, 'approve')
      expect(accepted.workflow.currentStage).toBe(key)
    }
    expect(store.workflow().status).toBe('COMPLETED')
    expect(store.workflow().completedStages).toEqual(['PREPARE', 'MEASURE', 'DISCUSS'])
    expect(() => store.confirmWorkflowPlan(stages)).toThrow('已完成')
  })

  it('leaves a rejected proposal pending and keeps confirmed routes scoped to their own run', async () => {
    const { store, agent } = setup(scripted([proposal()]))
    const rejected = await agent.chat('拟定流程')
    await agent.decide(rejected.approvals[0]!.id, 'reject')
    expect(store.workflow().plan).toEqual({ status: 'pending', stages: [] })
    const changed = [{ key: 'READ', label: '阅读资料', description: '共同核对源文档。' }]
    agent.setProvider(scripted([proposal(changed)]))
    const pending = await agent.chat('改成阅读资料后归档')
    await agent.decide(pending.approvals.find(item => item.status === 'PENDING')!.id, 'approve')
    const id = store.workflow().id
    store.addMessage('user', '保留我的对话')
    agent.newWorkflowRun('另一项研究')
    expect(store.workflow().plan?.status).toBe('pending')
    agent.switchWorkflowRun(id)
    expect(store.workflow().plan?.stages[0]?.key).toBe('READ')
    expect(store.messages().some(message => message.content === '保留我的对话')).toBe(true)
  })

  it('restores the exact proposal after restart and persists its confirmed route', async () => {
    const original = setup(scripted([proposal()]))
    const pending = await original.agent.chat('提出流程')
    const approvalId = pending.approvals[0]!.id
    original.close()
    const reopened = setup(undefined, original.path)
    expect(reopened.store.workflow().plan?.status).toBe('pending')
    const approved = await reopened.agent.decide(approvalId, 'approve')
    reopened.close()
    const restored = setup(undefined, original.path)
    expect(restored.store.workflow().plan).toEqual(approved.workflow.plan)
    expect(restored.store.workflow().currentStage).toBe('PREPARE')
  })

  it('protects completed and current stages while allowing approved future revisions', async () => {
    const { store, agent } = setup(scripted([proposal()]))
    const pending = await agent.chat('生成路线')
    await agent.decide(pending.approvals[0]!.id, 'approve')
    store.advance('MEASURE')
    const before = store.workflow()
    expect(() => store.confirmWorkflowPlan(stages.slice(1))).toThrow('已完成和当前阶段')
    expect(() => store.confirmWorkflowPlan([{ ...stages[0]!, label: '改写历史' }, ...stages.slice(1)])).toThrow('已完成和当前阶段')
    expect(store.workflow()).toEqual(before)
    const revised = [...stages.slice(0, 2), { key: 'REPORT', label: '整理报告', description: '记录来源与结论。' }]
    agent.setProvider(scripted([proposal(revised)]))
    const staged = await agent.chat('调整后续阶段为整理报告')
    expect(staged.workflow.plan).toEqual(before.plan)
    await agent.decide(staged.approvals.find(item => item.status === 'PENDING')!.id, 'approve')
    expect(store.workflow().completedStages).toEqual(['PREPARE'])
    expect(store.workflow().currentStage).toBe('MEASURE')
    expect(store.workflow().plan?.stages[2]?.key).toBe('REPORT')
  })

  it('rejects invalid proposals before showing an approval and leaves records unchanged', async () => {
    const invalid = [stages[0], stages[0]]
    const { store, agent } = setup(scripted([proposal(invalid), { content: '阶段重复，我会调整后再提出。' }]))
    const before = store.workflow()
    const result = await agent.chat('生成路线')
    expect(result.approvals).toEqual([])
    expect(store.workflow()).toEqual(before)
    for (const input of [[], [{ key: 'BAD', label: '名称' }], [{ ...stages[0], key: 'bad' }], [{ ...stages[0], key: 'CLOSED' }, stages[1]]]) {
      expect(() => proposedWorkflowStages(input, before)).toThrow()
    }
  })

  it('returns an actionable observation when a model tries to advance an unplanned run', async () => {
    const { store, agent } = setup(scripted([
      { content: '', toolCall: { name: 'workflow_advance', arguments: { stage: 'ASSAY' } } },
      { content: '流程尚未确定，我们先商讨阶段。' },
    ]))
    const result = await agent.chat('下一步')
    expect(result.approvals).toEqual([])
    expect(result.messages.at(-1)?.content).toContain('先商讨')
    expect(store.workflow().plan?.status).toBe('pending')
  })

  it('preserves historical routes and allows discussing their future stages', () => {
    const { store } = setup(undefined, undefined, true)
    const legacy = store.workflow()
    expect(legacy.plan?.status).toBe('confirmed')
    expect(legacy.plan?.stages).toHaveLength(13)
    expect(legacy.completedStages).toEqual(['DRAFT'])
    const revised = [...legacy.plan!.stages.slice(0, 2), ...stages]
    store.confirmWorkflowPlan(revised)
    expect(store.workflow().currentStage).toBe('DESIGN_REVIEW')
    expect(store.workflow().completedStages).toEqual(['DRAFT'])
    store.advance('PREPARE')
    expect(store.workflow().currentStage).toBe('PREPARE')
  })
})
