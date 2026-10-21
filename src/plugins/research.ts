import { ResearchService, type ResearchServiceOptions } from '../research/service.js'
import { ResearchStore } from '../research/store.js'
import { registerResearchTools } from '../agent/research-tools.js'
import { resolveRun, type WetFlowContext } from './types.js'

export const name = 'wetflow-research'
export const inject = ['wetflow']
export interface Config extends Omit<ResearchServiceOptions, 'store' | 'validateRunId'> { dbPath: string }
export function apply(ctx: WetFlowContext, config: Config): void {
  const store = new ResearchStore(config.dbPath)
  const service = new ResearchService({ ...config, store, validateRunId: runId => { resolveRun(ctx, runId) } })
  ctx.effect(() => async () => { await service.close(); store.close() }, 'Research jobs and database cleanup')
  ctx.reflect.provide('wetflowResearch', service)
  ctx.effect(() => ctx.wetflow.tools.mount('research', registry => {
    registerResearchTools(registry, () => service, candidate => resolveRun(ctx, candidate))
  }), 'Research tools')
}
