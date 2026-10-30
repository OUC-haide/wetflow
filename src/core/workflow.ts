import { WORKFLOW_STAGES, type WorkflowPlan, type WorkflowSnapshot, type WorkflowStage } from './types.js'

/** Old runs that already advanced keep their recorded route; drafts start unplanned. */
export function workflowPlan(workflow: Pick<WorkflowSnapshot, 'plan' | 'currentStage' | 'completedStages'>): WorkflowPlan {
  if (workflow.plan) return workflow.plan
  if (workflow.currentStage === 'DRAFT' && workflow.completedStages.length === 0) return { status: 'pending', stages: [] }
  return { status: 'confirmed', stages: WORKFLOW_STAGES.map(stage => ({ ...stage })) }
}

export function workflowStageLabel(workflow: WorkflowSnapshot): string {
  const plan = workflowPlan(workflow)
  return plan.status === 'pending' ? '待定' : plan.stages.find(stage => stage.key === workflow.currentStage)?.label ?? workflow.currentStage
}

/** Validate the complete proposal before display and again at the write boundary. */
export function proposedWorkflowStages(input: unknown, workflow: WorkflowSnapshot): WorkflowStage[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 21) throw new Error('请提供 1–20 个工作阶段及一个归档终点。')
  const keys = new Set<string>()
  const labels = new Set<string>()
  const stages = input.map((item: unknown): WorkflowStage => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('每个阶段必须提供标识、名称和说明。')
    const raw = item as Record<string, unknown>
    if (typeof raw.key !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(raw.key)) throw new Error('阶段标识须为大写英文、数字或下划线，以字母开头，最多 64 字符。')
    if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.trim().length > 80) throw new Error('阶段名称须为 1–80 字符。')
    if (typeof raw.description !== 'string' || !raw.description.trim() || raw.description.trim().length > 600) throw new Error('阶段说明须为 1–600 字符。')
    const stage = { key: raw.key, label: raw.label.trim(), description: raw.description.trim() }
    if (keys.has(stage.key) || labels.has(stage.label)) throw new Error('阶段标识和名称不能重复。')
    keys.add(stage.key); labels.add(stage.label)
    return stage
  })
  const closedIndex = stages.findIndex(stage => stage.key === 'CLOSED')
  if (closedIndex >= 0 && (closedIndex !== stages.length - 1 || stages.length < 2)) throw new Error('CLOSED 归档阶段只能放在流程末尾，前面必须有工作阶段。')
  if (closedIndex < 0) {
    if (stages.length > 20) throw new Error('最多支持 20 个工作阶段。')
    let label = '归档'
    while (labels.has(label)) label = `完成并${label}`
    stages.push({ key: 'CLOSED', label, description: '确认各阶段工作完成后归档。' })
  }
  const existing = workflowPlan(workflow)
  if (workflow.status === 'COMPLETED' || workflow.currentStage === 'CLOSED') throw new Error('已完成的流程不能改写，请新建运行。')
  if (existing.status === 'confirmed') {
    const currentIndex = existing.stages.findIndex(stage => stage.key === workflow.currentStage)
    if (currentIndex < 0) throw new Error('当前阶段不在已确认流程中。')
    for (let index = 0; index <= currentIndex; index += 1) {
      const previous = existing.stages[index]!
      const next = stages[index]
      if (!next || next.key !== previous.key || next.label !== previous.label || next.description !== previous.description) {
        throw new Error('已完成和当前阶段须保持不变；可以商讨并调整后续阶段。')
      }
    }
  }
  return stages
}
