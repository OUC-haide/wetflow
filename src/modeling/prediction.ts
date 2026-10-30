import type { IndustrialStore } from '../industrial/store.js'

/** Reuse the same run-scoped prediction when a task retries its registration. */
export function createModelingPrediction(store: IndustrialStore, runId: string, input: Record<string, unknown>): { id: string } {
  const artifactRef = typeof input.artifactRef === 'string' ? input.artifactRef.trim() : ''
  if (artifactRef) {
    const existing = store.predictionByArtifact(runId, artifactRef)
    if (existing) return { id: existing.id }
  }
  return store.addPrediction(runId, {
    model: String(input.model ?? 'local-modeling'), artifactRef: input.artifactRef,
    prediction: input.prediction, conditions: input.conditions, uncertainty: input.uncertainty,
    reason: input.reason,
  }, { id: 'wetflow-modeling-agent', role: 'application' })
}
