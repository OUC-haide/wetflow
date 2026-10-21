import { IndustrialStore } from '../industrial/store.js'
import { registerIndustrialTools } from '../agent/industrial-tools.js'
import { resolveRun, type ExperimentService, type WetFlowContext } from './types.js'

export const name = 'wetflow-experiment'
export const inject = ['wetflow']
export interface Config { dbPath: string }
export function apply(ctx: WetFlowContext, config: Config): void {
  let store: IndustrialStore | undefined
  let active = true
  const service: ExperimentService = { store: () => {
    if (!active) throw new Error('Experiment Plugin is unloaded')
    return store ??= new IndustrialStore(config.dbPath)
  } }
  ctx.effect(() => () => { active = false; store?.close() }, 'Experiment database cleanup')
  ctx.reflect.provide('wetflowExperiment', service)
  ctx.effect(() => ctx.wetflow.tools.mount('experiment', registry => {
    registerIndustrialTools(registry, { store: service.store, resolveRunId: candidate => resolveRun(ctx, candidate), actor: { id: 'wetflow-agent', role: 'agent' } })
  }), 'Experiment tools')
}
