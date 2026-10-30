import { proposedWorkflowStages } from '../core/workflow.js'
import type { WetFlowContext } from './types.js'
import type { WetFlowStore } from '../core/store.js'
import type { ToolRegistry } from '../agent/tools.js'

export const name = 'wetflow-workflow-planner'
export const inject = ['wetflow']
export const instructions = '流程由用户与你共同商讨。workflow.plan.status 为 pending 时，DRAFT 只是占位，不代表已选定阶段。先结合目标、资料和约束讨论路线，用户要求形成方案时调用 workflow_set_plan，等待审批。路线修改须保留已完成与当前阶段。'
export function registerPlanner(registry: ToolRegistry, store: WetFlowStore): void {
  registry.register({
    name: 'workflow_set_plan',
    description: '与用户商讨后提出当前运行的完整流程路线，用户确认后才保存。阶段由研究任务决定；未提供 CLOSED 时会补上归档终点并一同展示审批。修改路线时须原样保留已完成和当前阶段。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['stages'],
      properties: {
        stages: { type: 'array', minItems: 1, maxItems: 21, items: {
          type: 'object', additionalProperties: false, required: ['key', 'label', 'description'],
          properties: {
            key: { type: 'string', description: '稳定的阶段标识，大写英文、数字和下划线，以字母开头。归档终点使用 CLOSED。' },
            label: { type: 'string', description: '给用户看的阶段名称。' },
            description: { type: 'string', description: '阶段目标及推进前需要确认的事项；不编造实验条件。' },
          },
        } },
      },
    },
    approvalRequired: true,
    risk: 'MEDIUM',
    mutatesState: true,
    prepareProposal: input => {
      const stages = proposedWorkflowStages(input.stages, store.workflow())
      return { payload: { stages }, title: '确认流程路线', summary: `请确认以下流程路线：\n\n${stages.map((stage, index) => `${index + 1}. ${stage.label}：${stage.description}`).join('\n\n')}\n\n确认后保存；如需调整，请先拒绝，再继续商讨。` }
    },
    execute: input => store.confirmWorkflowPlan(input.stages),
  })
  registry.registerInstructions('workflow-planner', instructions)
}
export function apply(ctx: WetFlowContext): void {
  ctx.reflect.provide('wetflowPlanner', { enabled: true })
  ctx.effect(() => { ctx.wetflow.store.enableWorkflowPlanning(); return () => { ctx.wetflow.store.planningEnabled = false } }, 'Workflow planning defaults')
  ctx.effect(() => ctx.wetflow.tools.mount('workflow-planner', registry => registerPlanner(registry, ctx.wetflow.store)), 'Workflow planning tools')
}
