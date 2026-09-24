import type { Dataset, ModelMethod, ModelResult, ModelTask } from '../modeling/types.js'

const BASE = '/api/modeling'

export class ModelingApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ModelingApiError'
    this.status = status
  }
}

/** AbortController rejections are expected when a request is superseded; they are not user-facing errors. */
export function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

export interface SubmitInput {
  method: string
  parameters: Record<string, number>
  datasetId?: string
  budget: { wallTimeMs: number; maxOutputRows: number }
  title?: string
}

export interface PredictionInput {
  prediction: string
  conditions: string
  uncertainty: string
}

export interface ExperimentInput {
  experimentRef: string
  note: string
}

export interface PredictionRegistration {
  task: ModelTask
  predictionId: string
}

/** Server-advertised bounds; the UI prefers these over its documented fallbacks. */
export interface ModelLimits {
  defaultWallTimeMs: number
  maxWallTimeMs: number
  defaultMaxOutputRows: number
  maxOutputRows: number
  maxCsvBytes: number
  maxCsvRows: number
  maxExperimentNote: number
}

/**
 * Thin typed wrapper over the run-scoped `/api/modeling` REST contract.
 * Reads add `runId` as a query parameter, writes add it to the JSON body,
 * exactly matching the server handlers in `src/server.ts`.
 */
export class ModelingClient {
  private readonly runId: string
  private readonly base: string

  constructor(runId: string, base = BASE) {
    this.runId = runId
    this.base = base
  }

  private scopedUrl(path: string): string {
    const separator = path.includes('?') ? '&' : '?'
    return `${this.base}${path}${separator}runId=${encodeURIComponent(this.runId)}`
  }

  artifactUrl(taskId: string, artifactId: string): string {
    return this.scopedUrl(`/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`)
  }

  private async read<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.scopedUrl(path), signal ? { signal } : {})
    return this.decode<T>(response)
  }

  private async write<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: this.runId, ...body }),
      ...(signal ? { signal } : {}),
    })
    return this.decode<T>(response)
  }

  private async decode<T>(response: Response): Promise<T> {
    if (!response.ok) {
      let message = `请求失败 (${response.status})`
      try {
        const body = (await response.json()) as { error?: unknown }
        if (typeof body?.error === 'string' && body.error) message = body.error
      } catch {
        // Non-JSON error body: keep the status-based message.
      }
      throw new ModelingApiError(message, response.status)
    }
    return (await response.json()) as T
  }

  methods(signal?: AbortSignal): Promise<{ items: ModelMethod[]; limits?: ModelLimits }> {
    return this.read('/methods', signal)
  }

  datasets(signal?: AbortSignal): Promise<{ items: Dataset[] }> {
    return this.read('/datasets', signal)
  }

  tasks(signal?: AbortSignal): Promise<{ items: ModelTask[] }> {
    return this.read('/tasks', signal)
  }

  result(taskId: string, signal?: AbortSignal): Promise<ModelResult> {
    return this.read(`/tasks/${encodeURIComponent(taskId)}/result`, signal)
  }

  createDataset(name: string, csv: string, signal?: AbortSignal): Promise<Dataset> {
    return this.write('/datasets', { name, csv }, signal)
  }

  submit(input: SubmitInput, signal?: AbortSignal): Promise<ModelTask> {
    const body: Record<string, unknown> = {
      method: input.method,
      parameters: input.parameters,
      budget: input.budget,
    }
    if (input.datasetId) body.datasetId = input.datasetId
    if (input.title) body.title = input.title
    return this.write('/tasks', body, signal)
  }

  cancel(taskId: string, signal?: AbortSignal): Promise<ModelTask> {
    return this.write(`/tasks/${encodeURIComponent(taskId)}/cancel`, {}, signal)
  }

  registerPrediction(taskId: string, input: PredictionInput, signal?: AbortSignal): Promise<PredictionRegistration> {
    return this.write(`/tasks/${encodeURIComponent(taskId)}/prediction`, { ...input }, signal)
  }

  linkExperiment(taskId: string, input: ExperimentInput, signal?: AbortSignal): Promise<ModelTask> {
    return this.write(`/tasks/${encodeURIComponent(taskId)}/experiment`, { ...input }, signal)
  }

  async artifactText(taskId: string, artifactId: string, signal?: AbortSignal): Promise<string> {
    const response = await fetch(this.artifactUrl(taskId, artifactId), signal ? { signal } : {})
    if (!response.ok) throw new ModelingApiError(`无法读取结果文件 (${response.status})`, response.status)
    return response.text()
  }
}
