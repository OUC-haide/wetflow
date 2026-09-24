import { WORKFLOW_STAGES, type RiskLevel, type ToolDefinition, type ToolProposal, type WorkflowStageKey } from '../core/types.js'
import type { WetFlowStore } from '../core/store.js'

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<Record<string, unknown>, unknown>>()

  register(tool: ToolDefinition<Record<string, unknown>, unknown>): void {
    if (this.tools.has(tool.name)) throw new Error(`工具 ${tool.name} 已注册。`)
    this.tools.set(tool.name, tool)
  }

  list(): Array<{ name: string; description: string; approvalRequired: boolean }> {
    return [...this.tools.values()].map(({ name, description, approvalRequired }) => ({ name, description, approvalRequired }))
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * Full tool metadata for model providers: unlike `list`, this keeps the
   * optional JSON Schema so a provider can forward `parameters` verbatim. The
   * `execute` implementation is never exposed here.
   */
  definitions(): Array<{
    name: string
    description: string
    approvalRequired: boolean
    risk: RiskLevel
    parameters?: Record<string, unknown>
  }> {
    return [...this.tools.values()].map(({ name, description, approvalRequired, risk, parameters }) => ({
      name,
      description,
      approvalRequired,
      risk,
      ...(parameters ? { parameters } : {}),
    }))
  }

  get(name: string): ToolDefinition<Record<string, unknown>, unknown> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`未知工具：${name}`)
    return tool
  }
}

export function createWetFlowTools(store: WetFlowStore, now: () => Date = () => new Date()): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'workflow_status',
    description: '读取当前工作流阶段、状态和等待动作。',
    approvalRequired: false,
    risk: 'LOW',
    mutatesState: false,
    execute: () => store.workflow(),
  })
  registry.register({
    name: 'workflow_advance',
    description: '把工作流推进到唯一合法的下一阶段。',
    approvalRequired: true,
    risk: 'HIGH',
    mutatesState: true,
    execute: input => store.advance(String(input.stage) as WorkflowStageKey),
  })
  registry.register({
    name: 'workflow_pause',
    description: '暂停当前工作流，可选设置唤醒时间。',
    approvalRequired: true,
    risk: 'MEDIUM',
    mutatesState: true,
    execute: input => {
      const durationMs = Number(input.durationMs)
      const wakeAt = Number.isFinite(durationMs) && durationMs > 0
        ? new Date(now().getTime() + durationMs).toISOString()
        : input.wakeAt ? String(input.wakeAt) : undefined
      return store.setWorkflow({
        status: 'PAUSED',
        pauseReason: String(input.reason ?? '等待人工处理'),
        ...(wakeAt ? { wakeAt } : {}),
      })
    },
  })
  registry.register({
    name: 'workflow_wake',
    description: '唤醒暂停中的工作流并恢复 Agent。',
    approvalRequired: false,
    risk: 'LOW',
    mutatesState: true,
    execute: () => store.setWorkflow({ status: 'RUNNING', wakeAt: null, pauseReason: null }),
  })
  return registry
}

export function proposalForMessage(message: string, store: WetFlowStore): ToolProposal | undefined {
  const text = message.trim().toLowerCase()
  const workflow = store.workflow()
  if (/暂停|pause|稍后|等待/.test(text)) {
    const duration = parsePauseDuration(text)
    return {
      tool: 'workflow_pause',
      title: '暂停当前工作流',
      summary: `暂停「${workflow.name}」，${duration.label}后自动唤醒。`,
      payload: { reason: message.trim() || '用户要求暂停', durationMs: duration.ms },
    }
  }
  if (/推进|下一步|继续执行|advance/.test(text)) {
    const index = WORKFLOW_STAGES.findIndex(stage => stage.key === workflow.currentStage)
    const next = WORKFLOW_STAGES[index + 1]
    if (!next) return undefined
    return {
      tool: 'workflow_advance',
      title: `推进到「${next.label}」`,
      summary: `当前阶段为「${WORKFLOW_STAGES[index]?.label}」，通过后将进入 ${next.key}。`,
      payload: { stage: next.key },
    }
  }
  return undefined
}

function parsePauseDuration(text: string): { ms: number; label: string } {
  const match = text.match(/(\d+)\s*(秒|分钟|分|小时|时|seconds?|minutes?|hours?)/i)
  if (!match) return { ms: 60 * 60 * 1000, label: '一小时' }
  const amount = Math.max(1, Math.min(24 * 60, Number(match[1])))
  const unit = match[2]?.toLowerCase() ?? '小时'
  if (unit === '秒' || unit.startsWith('second')) return { ms: amount * 1000, label: `${amount} 秒` }
  if (unit === '分钟' || unit === '分' || unit.startsWith('minute')) return { ms: amount * 60 * 1000, label: `${amount} 分钟` }
  return { ms: amount * 60 * 60 * 1000, label: `${amount} 小时` }
}
