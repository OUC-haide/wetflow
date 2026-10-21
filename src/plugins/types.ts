import type { WetFlowAgent } from '../agent/runtime.js'
import type { WetFlowStore } from '../core/store.js'
import type { ModelingService } from '../modeling/service.js'
import type { ResearchService } from '../research/service.js'
import type { IndustrialStore } from '../industrial/store.js'

export type PluginId = 'evidence' | 'research' | 'modeling' | 'experiment'
export const PLUGIN_IDS: PluginId[] = ['evidence', 'research', 'modeling', 'experiment']
export interface EvidenceService {
  sources: WetFlowStore['evidenceSources']
  search: WetFlowStore['searchEvidence']
  add: WetFlowStore['addEvidenceSource']
}
export interface ExperimentService { store(): IndustrialStore }
export interface PluginFiber {
  state: number
  dispose(): Promise<void>
}
export interface WetFlowContext {
  wetflow: WetFlowAgent
  wetflowEvidence?: EvidenceService
  wetflowResearch?: ResearchService
  wetflowModeling?: ModelingService
  wetflowExperiment?: ExperimentService
  reflect: { provide(name: string, value: unknown): unknown }
  effect(execute: () => () => void | Promise<void>, label?: string): unknown
  plugin(plugin: unknown, config?: unknown): PromiseLike<PluginFiber>
  fiber: PluginFiber
}
export function resolveRun(ctx: WetFlowContext, candidate?: unknown): string {
  const runId = typeof candidate === 'string' && candidate.trim() ? candidate.trim() : ctx.wetflow.store.activeWorkflowRunId()
  if (!ctx.wetflow.store.workflowRuns().some(run => run.id === runId)) throw new Error('工作流运行不存在。')
  return runId
}
