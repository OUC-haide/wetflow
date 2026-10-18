import { ModelingService, type ModelingServiceOptions } from '../modeling/service.js'
import { registerModelingTools } from '../agent/modeling-tools.js'
import { resolveRun, type WetFlowContext } from './types.js'

export const name = 'wetflow-modeling'
export const inject = ['wetflow']
export type Config = Omit<ModelingServiceOptions, 'validateRunId'>
export function apply(ctx: WetFlowContext, config: Config): void {
  const service = new ModelingService({ ...config, validateRunId: runId => { resolveRun(ctx, runId) } })
  ctx.effect(() => () => service.close(), 'Modeling worker cleanup')
  ctx.reflect.provide('wetflowModeling', service)
  ctx.effect(() => ctx.wetflow.tools.mount('modeling', registry => {
    registerModelingTools(registry, () => service, candidate => resolveRun(ctx, candidate))
  }), 'Modeling tools')
}
