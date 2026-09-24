export type ModelStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'

export interface ModelMethod {
  id: 'monod_batch' | 'growth_fit'
  /** Immutable model/method revision captured from the job, not claimed by a caller. */
  version: string
  label: string
  description: string
  inputSchema: Record<string, unknown>
  units: Record<string, string>
  assumptions: string[]
  limitations: string[]
}

/** Enforced input/budget bounds, exposed so clients can surface the real limits. */
export interface ModelLimits {
  defaultWallTimeMs: number
  maxWallTimeMs: number
  defaultMaxOutputRows: number
  maxOutputRows: number
  maxCsvBytes: number
  maxCsvRows: number
  maxExperimentNote: number
}

export interface Dataset {
  id: string
  runId: string
  name: string
  columns: string[]
  rowCount: number
  createdAt: string
}

export interface ModelBudget {
  wallTimeMs: number
  maxOutputRows: number
}

export interface ModelTask {
  id: string
  runId: string
  method: string
  /** Version derived from the method at submit time and confirmed by the worker result. */
  methodVersion: string
  title: string
  status: ModelStatus
  parameters: Record<string, unknown>
  datasetId?: string
  budget: ModelBudget
  createdAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
  predictionId?: string
  linkedExperiment?: string
  linkedExperimentNote?: string
}

export interface ModelArtifact {
  id: string
  name: string
  mediaType: string
  sizeBytes: number
}

export interface ModelResult {
  taskId: string
  method: string
  methodVersion: string
  summary: Record<string, unknown>
  metrics: Record<string, number>
  /** Fit diagnostics (for example rSquared) are NOT uncertainty intervals. */
  diagnostics?: Record<string, number>
  units: Record<string, string>
  assumptions: string[]
  limitations: string[]
  /** Explicit statement when the model does not provide a quantified uncertainty. */
  uncertaintyNote?: string
  artifacts: ModelArtifact[]
}
