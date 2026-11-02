import { estimateTokens } from '../agent/context.js'
import type { Catalogue } from './types.js'

/** Names and stable IDs only; never place measurements or free-form notes here. */
export function catalogueContext(catalogue: Catalogue, projectId: string, tokenBudget: number) {
  const entries = {
    rounds: catalogue.rounds.map(({ id, number, name }) => ({ id, number, name })),
    batches: catalogue.batches.map(({ id, roundId, code, name }) => ({ id, roundId, code, name })),
    metrics: catalogue.metrics.map(({ id, code, name, unit }) => ({ id, code, name, unit })),
  }
  const totals = { rounds: entries.rounds.length, batches: entries.batches.length, metrics: entries.metrics.length }
  const data = { projectId, recordCount: catalogue.recordCount, totals,
    rounds: [] as typeof entries.rounds, batches: [] as typeof entries.batches, metrics: [] as typeof entries.metrics,
    omitted: { ...totals }, lookupTool: 'batch_data_catalog' }
  const fits = () => estimateTokens(JSON.stringify(data)) <= tokenBudget
  if (!fits()) return undefined
  const keys = ['rounds', 'batches', 'metrics'] as const
  const blocked = new Set<typeof keys[number]>()
  // Interleave categories so a long list of rounds does not hide all batches
  // and metrics. Omitted counts tell the model to request the remaining names.
  while (blocked.size < keys.length) {
    for (const key of keys) {
      if (blocked.has(key)) continue
      const target: Array<(typeof entries)[typeof key][number]> = data[key]
      const item = entries[key][target.length]
      if (!item) { blocked.add(key); continue }
      target.push(item)
      data.omitted[key] -= 1
      if (!fits()) {
        target.pop()
        data.omitted[key] += 1
        blocked.add(key)
      }
    }
  }
  return data
}
