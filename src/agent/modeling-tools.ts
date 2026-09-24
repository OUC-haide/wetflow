import type { ModelingService } from '../modeling/service.js'
import type { ToolRegistry } from './tools.js'

type RunResolver = (candidate?: unknown) => string
type ServiceResolver = (runId: string) => ModelingService

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false,
})
const id = { type: 'string', minLength: 1, maxLength: 160 }
const text = (maximum: number) => ({ type: 'string', maxLength: maximum })
/** Optional explicit run; the server validates it and falls back to the active run. */
const runIdProperty = { type: 'string', minLength: 1, maxLength: 160, description: '工作流运行 ID；省略时使用当前运行。' }
const DEFAULT_TASK_LIST_LIMIT = 20
const MAX_TASK_LIST_LIMIT = 50

/**
 * Register native, run-scoped agent tools backed by the same allowlisted local
 * service as REST. Every tool resolves and validates the workflow run first, so a
 * task or dataset from another run is never visible through the agent.
 *
 * These definitions reuse the current core `ToolDefinition`: read-only tools and
 * state-changing tools are labelled with `mutatesState`, while no industrial
 * measurement authorization regex is applied — modeling inputs are numerical
 * model parameters, not user-reported measurements.
 */
export function registerModelingTools(registry: ToolRegistry, serviceFor: ServiceResolver, resolveRunId: RunResolver): void {
  const add = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    mutatesState: boolean,
    execute: (service: ModelingService, args: Record<string, unknown>, runId: string) => unknown,
  ) => {
    registry.register({
      name,
      description,
      parameters,
      approvalRequired: false,
      risk: 'LOW',
      mutatesState,
      execute: input => {
        const args = input as Record<string, unknown>
        const runId = resolveRunId(args.runId)
        return execute(serviceFor(runId), args, runId)
      },
    })
  }

  add('modeling_methods', '读取可用模型方法、输入参数 schema、单位和科学假设（方法版本由任务记录）。', object({}), false,
    service => service.methods())

  add('modeling_datasets', '列出当前工作流运行拥有的数据集及其行数。CSV 上传请使用 /api/modeling/datasets。',
    object({ runId: runIdProperty }), false, (service, _args, runId) => ({ items: service.listDatasets(runId) }))

  add('modeling_list_tasks', '列出当前工作流运行最近的建模任务（有界摘要），用于稍后在新对话中重新定位任务 ID；不返回无界结果。', object({
    runId: runIdProperty,
    limit: { type: 'integer', minimum: 1, maximum: MAX_TASK_LIST_LIMIT, description: `返回条数上限，默认 ${DEFAULT_TASK_LIST_LIMIT}。` },
  }), false, (service, args, runId) => {
    const requested = typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : DEFAULT_TASK_LIST_LIMIT
    const limit = Math.max(1, Math.min(MAX_TASK_LIST_LIMIT, requested))
    const tasks = service.list(runId)
    const selected = tasks.slice(0, limit)
    return {
      items: selected.map(task => ({
        id: task.id, method: task.method, methodVersion: task.methodVersion, title: task.title,
        status: task.status, createdAt: task.createdAt,
        ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
        ...(task.predictionId ? { predictionId: task.predictionId } : {}),
        ...(task.linkedExperiment ? { linkedExperiment: task.linkedExperiment } : {}),
      })),
      total: tasks.length,
      returned: selected.length,
      truncated: tasks.length > selected.length,
    }
  })

  add('modeling_submit', '提交 allowlisted 本地数值建模任务；立即返回真实任务 ID，稍后用 modeling_status 查询，不要在此轮询等待。', object({
    runId: runIdProperty,
    method: { type: 'string', enum: ['monod_batch', 'growth_fit'] },
    parameters: { type: 'object', description: 'monod_batch 需要 initialBiomass/initialSubstrate/muMax/halfSaturation/yield/duration/timeStep；growth_fit 传空对象。' },
    datasetId: id,
    title: text(160),
    budget: object({ wallTimeMs: { type: 'integer', minimum: 100, maximum: 120000 }, maxOutputRows: { type: 'integer', minimum: 2, maximum: 20001 } }),
  }, ['method', 'parameters']), true, (service, args, runId) => service.submit(runId, {
    method: String(args.method),
    parameters: args.parameters as Record<string, unknown>,
    ...(typeof args.datasetId === 'string' ? { datasetId: args.datasetId } : {}),
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    ...(args.budget && typeof args.budget === 'object' ? { budget: args.budget as { wallTimeMs?: number; maxOutputRows?: number } } : {}),
  }))

  add('modeling_status', '读取任务状态；长任务不会在工具调用中轮询等待。', object({ runId: runIdProperty, taskId: id }, ['taskId']),
    false, (service, args, runId) => service.get(runId, String(args.taskId)))

  add('modeling_result', '读取成功任务的结构化数值结果、方法版本、单位及受控 artifacts 元数据。', object({ runId: runIdProperty, taskId: id }, ['taskId']),
    false, (service, args, runId) => service.result(runId, String(args.taskId)))

  add('modeling_cancel', '取消指定运行中或排队中的本地建模任务。', object({ runId: runIdProperty, taskId: id }, ['taskId']),
    true, (service, args, runId) => service.cancel(runId, String(args.taskId)))

  add('modeling_register_prediction', '把成功计算登记为工业预测记录，引用实际任务结果；登记不代表实验验证。', object({
    runId: runIdProperty,
    taskId: id,
    prediction: { type: 'string', minLength: 2, maxLength: 2000 },
    conditions: text(500),
    uncertainty: text(500),
    linkedExperiment: text(500),
  }, ['taskId', 'prediction']), true, (service, args, runId) => service.registerPrediction(runId, String(args.taskId), {
    prediction: String(args.prediction),
    ...(typeof args.conditions === 'string' ? { conditions: args.conditions } : {}),
    ...(typeof args.uncertainty === 'string' ? { uncertainty: args.uncertainty } : {}),
    ...(typeof args.linkedExperiment === 'string' ? { linkedExperiment: args.linkedExperiment } : {}),
  }))

  add('modeling_link_experiment', '关联实验引用以便后续追踪；关联本身不代表实验已经执行或预测已确认。', object({
    // note is capped at 600 to match the service/IndustrialStore audit boundary.
    runId: runIdProperty,
    taskId: id, experimentRef: { type: 'string', minLength: 1, maxLength: 500 }, note: text(600),
  }, ['taskId', 'experimentRef']), true, (service, args, runId) => service.linkExperiment(runId, String(args.taskId), {
    experimentRef: String(args.experimentRef),
    ...(typeof args.note === 'string' ? { note: args.note } : {}),
  }))
}
