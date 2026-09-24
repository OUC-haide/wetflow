import { spawn, type ChildProcess } from 'node:child_process'
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync,
  unlinkSync, realpathSync, lstatSync, type Dirent, type Stats,
} from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Dataset, ModelBudget, ModelLimits, ModelMethod, ModelResult, ModelStatus, ModelTask } from './types.js'

const MAX_CSV_BYTES = 2_000_000
const MAX_CSV_ROWS = 20_000
const MAX_CSV_COLUMNS = 50
const DEFAULT_WALL_MS = 30_000
const MIN_WALL_MS = 100
const MAX_WALL_MS = 120_000
const DEFAULT_OUTPUT_ROWS = 5_000
const MAX_OUTPUT_ROWS = 20_001
const MAX_STDOUT_CHARS = 1_000_000
const MAX_STDERR_CHARS = 16_000
const MAX_WORKER_JSON_BYTES = 2_000_000
const MAX_ARTIFACT_BYTES = 8_000_000
const KILL_GRACE_MS = 1_000
const MAX_EXPERIMENT_NOTE = 600
const MONOD_VERSION = 'monod-conservative-rk4-2'
const GROWTH_FIT_VERSION = 'log-linear-ols-2'
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const STATUSES = new Set<ModelStatus>(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])

const MONOD_KEYS = ['initialBiomass', 'initialSubstrate', 'muMax', 'halfSaturation', 'yield', 'duration', 'timeStep'] as const
type MonodKey = (typeof MONOD_KEYS)[number]

interface NumberBounds { minimum: number; exclusiveMinimum?: boolean; maximum: number }
/** Bounds mirror the worker's guards so an out-of-range job is rejected before it is queued. */
const MONOD_BOUNDS: Record<MonodKey, NumberBounds> = {
  initialBiomass: { minimum: 0, exclusiveMinimum: true, maximum: 1e6 },
  initialSubstrate: { minimum: 0, maximum: 1e6 },
  muMax: { minimum: 0, exclusiveMinimum: true, maximum: 1e3 },
  halfSaturation: { minimum: 0, exclusiveMinimum: true, maximum: 1e6 },
  yield: { minimum: 1e-6, maximum: 1e3 },
  duration: { minimum: 0, exclusiveMinimum: true, maximum: 1e4 },
  timeStep: { minimum: 0, exclusiveMinimum: true, maximum: 1e4 },
}

const METHODS: ModelMethod[] = [
  {
    id: 'monod_batch',
    version: MONOD_VERSION,
    label: 'Monod batch simulation',
    description: 'Integrate biomass and limiting substrate in an idealized well-mixed batch culture with a mass-conserving adaptive solver.',
    inputSchema: {
      type: 'object',
      required: [...MONOD_KEYS],
      additionalProperties: false,
      properties: {
        initialBiomass: { type: 'number', exclusiveMinimum: 0, maximum: 1e6, unit: 'g/L' },
        initialSubstrate: { type: 'number', minimum: 0, maximum: 1e6, unit: 'g/L' },
        muMax: { type: 'number', exclusiveMinimum: 0, maximum: 1e3, unit: '1/h' },
        halfSaturation: { type: 'number', exclusiveMinimum: 0, maximum: 1e6, unit: 'g/L' },
        yield: { type: 'number', minimum: 1e-6, maximum: 1e3, unit: 'g-biomass/g-substrate' },
        duration: { type: 'number', exclusiveMinimum: 0, maximum: 1e4, unit: 'h' },
        timeStep: { type: 'number', exclusiveMinimum: 0, maximum: 1e4, unit: 'h' },
      },
    },
    units: { time: 'h', biomass: 'g/L', substrate: 'g/L' },
    assumptions: [
      'Well-mixed batch culture at constant temperature with constant yield Yx/s.',
      'Growth follows Monod kinetics; maintenance, death, inhibition, product formation and feeding are excluded.',
      'The invariant X + Y*S = X0 + Y*S0 is enforced at every reported step.',
    ],
    limitations: ['Idealized model prediction, not measured evidence; no product model.'],
  },
  {
    id: 'growth_fit',
    version: GROWTH_FIT_VERSION,
    label: 'Exponential growth fit',
    description: 'Fit log biomass against time (fixed units: time in h, biomass in g/L) by ordinary least squares.',
    inputSchema: {
      type: 'object',
      required: ['datasetId'],
      additionalProperties: false,
      properties: { datasetId: { type: 'string', minLength: 1, maxLength: 100, unit: 'dataset id' } },
    },
    units: { time: 'h', biomass: 'g/L', growthRate: '1/h', doublingTime: 'h' },
    assumptions: ['Every supplied point lies in one exponential growth phase; the user selects that phase.'],
    limitations: ['No automatic growth-phase detection; rSquared/logRmse are fit diagnostics, not uncertainty intervals.'],
  },
]
const METHOD_BY_ID = new Map<string, ModelMethod>(METHODS.map(method => [method.id, method]))

const LIMITS: ModelLimits = {
  defaultWallTimeMs: DEFAULT_WALL_MS,
  maxWallTimeMs: MAX_WALL_MS,
  defaultMaxOutputRows: DEFAULT_OUTPUT_ROWS,
  maxOutputRows: MAX_OUTPUT_ROWS,
  maxCsvBytes: MAX_CSV_BYTES,
  maxCsvRows: MAX_CSV_ROWS,
  maxExperimentNote: MAX_EXPERIMENT_NOTE,
}

const ARTIFACTS: Record<string, { name: string; mediaType: string }> = {
  trajectory: { name: 'output.csv', mediaType: 'text/csv' },
  result: { name: 'result.json', mediaType: 'application/json' },
}

interface WorkerResult {
  method: string
  methodVersion: string
  summary: Record<string, unknown>
  metrics: Record<string, number>
  diagnostics?: Record<string, number>
  units: Record<string, string>
  assumptions: string[]
  limitations: string[]
  uncertaintyNote?: string
}

interface ActiveJob {
  child: ChildProcess
  timer: NodeJS.Timeout | undefined
  killTimer: NodeJS.Timeout | undefined
  done: Promise<void>
  resolveDone: () => void
  stdout: string
  stderr: string
  overflow: boolean
  spawnError: Error | undefined
  exitCode: number | null
  settled: boolean
  finalize: () => void
}

export interface ModelingServiceOptions {
  dataDir: string
  validateRunId: (runId: string) => void
  createPrediction: (runId: string, input: Record<string, unknown>) => { id: string }
  /** Optional scoped adapter that attaches an experiment reference to a registered prediction. */
  linkPrediction?: (runId: string, predictionId: string, experimentRef: string, note: string) => void
  /** Test-only override of the Python interpreter; never reachable from HTTP or agent input. */
  pythonExecutable?: string
  /** Test-only fixture worker script; never reachable from HTTP or agent input. */
  workerScript?: string
  concurrency?: number
}

function err(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function own(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function clone<T>(value: T): T {
  return structuredClone(value)
}
function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
}
function safeId(value: string): string {
  if (!ID_RE.test(value)) throw new Error('Invalid owned identifier')
  return value
}
function boundedNumber(value: unknown, name: string, bounds: NumberBounds): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
  if (bounds.exclusiveMinimum ? value <= bounds.minimum : value < bounds.minimum) {
    throw new Error(`${name} must be ${bounds.exclusiveMinimum ? 'greater than' : 'at least'} ${bounds.minimum}`)
  }
  if (value > bounds.maximum) throw new Error(`${name} must not exceed ${bounds.maximum}`)
  return value
}
function expectedTrajectoryRows(duration: number, timeStep: number): number {
  const ratio = duration / timeStep
  if (!Number.isFinite(ratio)) return Number.POSITIVE_INFINITY
  return Math.max(2, Math.ceil(ratio - 1e-9) + 1)
}
function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

interface ParsedCsv { columns: string[]; rows: Array<Record<string, string>> }

function parseCsv(text: string): ParsedCsv {
  if (typeof text !== 'string') throw new Error('CSV must be text')
  if (text.length > MAX_CSV_BYTES) throw new Error(`CSV exceeds ${MAX_CSV_BYTES} bytes`)
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  if (lines.length < 2 || lines.length > MAX_CSV_ROWS + 1) throw new Error(`CSV requires 1-${MAX_CSV_ROWS} data rows`)
  const columns = lines[0]!.split(',').map(value => value.trim())
  if (columns.length < 2 || columns.length > MAX_CSV_COLUMNS || new Set(columns).size !== columns.length
    || columns.some(value => !value || value.length > 80)) {
    throw new Error('Invalid CSV header')
  }
  const rows = lines.slice(1).map((line, index) => {
    const cells = line.split(',')
    if (cells.length !== columns.length) throw new Error(`CSV row ${index + 2} has the wrong column count`)
    return Object.fromEntries(columns.map((column, position) => [column, cells[position]!.trim()]))
  })
  return { columns, rows }
}

function validateDatasetRows(parsed: ParsedCsv): void {
  for (const column of ['time', 'biomass']) {
    if (!parsed.columns.includes(column)) throw new Error(`CSV must contain a ${column} column`)
  }
  let previousTime = -Infinity
  for (const [index, row] of parsed.rows.entries()) {
    for (const column of ['time', 'biomass'] as const) {
      const cell = row[column]!
      if (cell === '') throw new Error(`CSV ${column} is blank at row ${index + 2}`)
      const numeric = Number(cell)
      if (!Number.isFinite(numeric)) throw new Error(`CSV ${column} must be finite at row ${index + 2}`)
      if (column === 'time') {
        if (numeric <= previousTime) throw new Error('CSV time values must strictly increase')
        previousTime = numeric
      } else if (numeric <= 0) {
        throw new Error('CSV biomass must be positive')
      }
    }
  }
}

function normalizeDataset(value: unknown, runId: string): Dataset | undefined {
  if (!own(value)) return undefined
  if (value.runId !== runId) return undefined
  if (typeof value.id !== 'string' || !ID_RE.test(value.id)) return undefined
  if (typeof value.name !== 'string' || !value.name) return undefined
  if (typeof value.createdAt !== 'string') return undefined
  if (!Number.isInteger(value.rowCount) || (value.rowCount as number) < 1) return undefined
  if (!Array.isArray(value.columns) || !value.columns.every(column => typeof column === 'string')) return undefined
  return {
    id: value.id, runId, name: value.name, columns: value.columns as string[],
    rowCount: value.rowCount as number, createdAt: value.createdAt,
  }
}

function validateWorkerResult(value: unknown, task: ModelTask): WorkerResult {
  if (!own(value)) throw new Error('Worker result must be a JSON object')
  if (value.method !== task.method) throw new Error('Worker result method does not match the task')
  if (typeof value.methodVersion !== 'string' || value.methodVersion !== task.methodVersion) {
    throw new Error('Worker result method version does not match the task')
  }
  if (!own(value.summary)) throw new Error('Worker result summary must be an object')
  for (const [name, summaryValue] of Object.entries(value.summary)) {
    if (typeof summaryValue === 'number' && !Number.isFinite(summaryValue)) {
      throw new Error(`Worker summary ${name} is not finite`)
    }
  }
  if (!own(value.metrics)) throw new Error('Worker result metrics must be an object')
  const metrics: Record<string, number> = {}
  for (const [name, metric] of Object.entries(value.metrics)) {
    if (typeof metric !== 'number' || !Number.isFinite(metric)) throw new Error(`Worker metric ${name} is not finite`)
    metrics[name] = metric
  }
  if (Object.keys(metrics).length === 0) throw new Error('Worker result has no metrics')
  if (!own(value.units)) throw new Error('Worker result units must be an object')
  const units: Record<string, string> = {}
  for (const [name, unit] of Object.entries(value.units)) {
    if (typeof unit !== 'string' || !unit.trim()) throw new Error(`Worker unit ${name} is invalid`)
    units[name] = unit
  }
  for (const name of Object.keys(metrics)) {
    if (!units[name]) throw new Error(`Worker metric ${name} is missing a unit`)
  }
  let diagnostics: Record<string, number> | undefined
  if (value.diagnostics !== undefined) {
    if (!own(value.diagnostics)) throw new Error('Worker diagnostics must be an object')
    diagnostics = {}
    for (const [name, diagnostic] of Object.entries(value.diagnostics)) {
      if (typeof diagnostic !== 'number' || !Number.isFinite(diagnostic)) throw new Error(`Worker diagnostic ${name} is not finite`)
      if (!units[name]) throw new Error(`Worker diagnostic ${name} is missing a unit`)
      diagnostics[name] = diagnostic
    }
  }
  if (!Array.isArray(value.assumptions) || !value.assumptions.every(item => typeof item === 'string' && item.trim())) {
    throw new Error('Worker assumptions must be a non-empty string array')
  }
  if (!Array.isArray(value.limitations) || !value.limitations.every(item => typeof item === 'string' && item.trim())) {
    throw new Error('Worker limitations must be a non-empty string array')
  }
  if (value.uncertaintyNote !== undefined && typeof value.uncertaintyNote !== 'string') {
    throw new Error('Worker uncertaintyNote must be text')
  }
  return {
    method: task.method,
    methodVersion: task.methodVersion,
    summary: value.summary,
    metrics,
    ...(diagnostics ? { diagnostics } : {}),
    units,
    assumptions: value.assumptions as string[],
    limitations: value.limitations as string[],
    ...(typeof value.uncertaintyNote === 'string' && value.uncertaintyNote.trim() ? { uncertaintyNote: value.uncertaintyNote } : {}),
  }
}

function workerErrorMessage(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim()
  } catch { /* not JSON; fall through to stderr */ }
  return ''
}

/**
 * Owns datasets, queued numerical jobs, worker subprocesses, and run-scoped
 * artifacts for the local modeling subsystem. Every filesystem path is derived
 * from validated ids below a single configured root; symlinked components and
 * non-regular files are rejected before any read or write.
 */
export class ModelingService {
  private readonly root: string
  private readonly realRoot: string
  private readonly validateRunId: (runId: string) => void
  private readonly createPrediction: (runId: string, input: Record<string, unknown>) => { id: string }
  private readonly linkPrediction: ((runId: string, predictionId: string, experimentRef: string, note: string) => void) | undefined
  private readonly python: string
  private readonly workerScriptOverride: string | undefined
  private readonly concurrency: number
  private readonly tasks = new Map<string, ModelTask>()
  private readonly datasets = new Map<string, Dataset>()
  private readonly active = new Map<string, ActiveJob>()
  private closed = false

  constructor(options: ModelingServiceOptions) {
    this.validateRunId = options.validateRunId
    this.createPrediction = options.createPrediction
    this.linkPrediction = options.linkPrediction
    this.python = options.pythonExecutable || process.env.PYTHON_EXECUTABLE || 'python3'
    this.workerScriptOverride = options.workerScript ? resolve(options.workerScript) : undefined
    this.concurrency = Math.max(1, Math.min(4, options.concurrency ?? 2))
    this.root = resolve(options.dataDir)
    mkdirSync(this.root, { recursive: true })
    this.realRoot = realpathSync(this.root)
    this.recover()
  }

  // ------------------------------------------------------------------ public API

  methods(): { items: ModelMethod[]; limits: ModelLimits } {
    return { items: clone(METHODS), limits: { ...LIMITS } }
  }

  createDataset(runId: string, input: { name: string; csv: string }): Dataset {
    this.assertOpen()
    this.runDir(runId)
    if (!own(input)) throw new Error('dataset payload must be an object')
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 120) throw new Error('Dataset name must be 1-120 characters')
    const csv = typeof input.csv === 'string' ? input.csv : ''
    const parsed = parseCsv(csv)
    validateDatasetRows(parsed)

    const dataset: Dataset = {
      id: randomUUID(), runId, name, columns: parsed.columns,
      rowCount: parsed.rows.length, createdAt: new Date().toISOString(),
    }
    const jsonPath = this.datasetJsonPath(runId, dataset.id)
    const csvPath = this.datasetCsvPath(runId, dataset.id)
    try {
      this.atomicWrite(csvPath, csv)
      this.atomicWrite(jsonPath, JSON.stringify(dataset))
    } catch (error) {
      for (const path of [csvPath, jsonPath]) {
        try { unlinkSync(path) } catch { /* best effort cleanup */ }
      }
      throw new Error(`Failed to persist dataset: ${err(error)}`)
    }
    this.datasets.set(this.key(runId, dataset.id), dataset)
    return clone(dataset)
  }

  listDatasets(runId: string): Dataset[] {
    this.validateRun(runId)
    let files: string[]
    try { files = readdirSync(this.readOwnedDir(join(this.realRoot, runId, 'datasets'))) } catch { return [] }
    const found: Dataset[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = JSON.parse(this.readOwnedText(join(this.realRoot, runId, 'datasets', file)))
        const dataset = normalizeDataset(raw, runId)
        if (!dataset) continue
        this.datasets.set(this.key(runId, dataset.id), dataset)
        found.push(clone(dataset))
      } catch { /* corrupt dataset records are ignored rather than trusted */ }
    }
    return found.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  submit(runId: string, input: {
    method: string
    parameters: Record<string, unknown>
    datasetId?: string
    budget?: { wallTimeMs?: number; maxOutputRows?: number }
    title?: string
  }): ModelTask {
    this.assertOpen()
    this.validateRun(runId)
    if (!own(input)) throw new Error('submit payload must be an object')
    const method = typeof input.method === 'string' ? input.method : ''
    const definition = METHOD_BY_ID.get(method)
    if (!definition) throw new Error('Unknown modeling method')
    if (!own(input.parameters)) throw new Error('parameters must be an object')
    const parameters = this.validateParameters(method, input.parameters)
    const budget = this.validateBudget(input.budget)

    let datasetId: string | undefined
    if (method === 'growth_fit') {
      if (typeof input.datasetId !== 'string' || !input.datasetId.trim()) throw new Error('growth_fit requires a datasetId')
      datasetId = safeId(input.datasetId.trim())
      const { rows } = this.loadDataset(runId, datasetId)
      if (rows.length < 3) throw new Error('growth_fit requires at least 3 data points')
      if (rows.length > budget.maxOutputRows) throw new Error('Fitted output exceeds the maxOutputRows budget')
    } else if (input.datasetId !== undefined) {
      throw new Error('monod_batch does not accept a datasetId')
    }

    if (method === 'monod_batch') {
      const rows = expectedTrajectoryRows(parameters.duration as number, parameters.timeStep as number)
      if (rows > budget.maxOutputRows) throw new Error('Trajectory exceeds the maxOutputRows budget')
    }

    let title = method
    if (input.title !== undefined) {
      if (typeof input.title !== 'string') throw new Error('title must be text')
      title = input.title.trim() || method
    }
    if (title.length > 120) throw new Error('title must be 120 characters or fewer')

    const task: ModelTask = {
      id: randomUUID(), runId, method, methodVersion: definition.version, title,
      status: 'QUEUED', parameters, budget, createdAt: new Date().toISOString(),
    }
    if (datasetId !== undefined) task.datasetId = datasetId
    // Persist before publishing in memory: a failed write must not leave a phantom job.
    this.persistTask(task)
    this.tasks.set(this.key(runId, task.id), task)
    this.pump()
    return clone(task)
  }

  list(runId: string): ModelTask[] {
    this.validateRun(runId)
    return [...this.tasks.values()]
      .filter(task => task.runId === runId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone)
  }

  get(runId: string, taskId: string): ModelTask {
    return clone(this.requireTask(runId, taskId))
  }

  cancel(runId: string, taskId: string): ModelTask {
    const task = this.requireTask(runId, taskId)
    if (task.status === 'QUEUED') {
      task.status = 'CANCELLED'
      task.finishedAt = new Date().toISOString()
      try { this.persistTask(task) } catch { /* in-memory state stays authoritative */ }
      this.pump()
      return clone(task)
    }
    if (task.status === 'RUNNING') {
      task.status = 'CANCELLED'
      task.error = 'Cancelled by user'
      task.finishedAt = new Date().toISOString()
      const job = this.active.get(this.key(runId, taskId))
      if (job) this.terminate(job)
      try { this.persistTask(task) } catch { /* in-memory state stays authoritative */ }
    }
    return clone(task)
  }

  result(runId: string, taskId: string): ModelResult {
    const task = this.requireTask(runId, taskId)
    if (task.status !== 'SUCCEEDED') throw new Error('Result is available only for succeeded tasks')
    const dir = this.taskDir(runId, taskId)
    const parsed = validateWorkerResult(JSON.parse(this.readOwnedText(join(dir, 'result.json'))), task)
    const artifacts: ModelResult['artifacts'] = []
    for (const [artifactId, entry] of Object.entries(ARTIFACTS)) {
      const stat = this.ownedFileStat(join(dir, entry.name))
      artifacts.push({ id: artifactId, name: entry.name, mediaType: entry.mediaType, sizeBytes: stat.size })
    }
    return {
      taskId: task.id, method: task.method, methodVersion: task.methodVersion,
      summary: parsed.summary, metrics: parsed.metrics,
      ...(parsed.diagnostics ? { diagnostics: parsed.diagnostics } : {}),
      units: parsed.units, assumptions: parsed.assumptions, limitations: parsed.limitations,
      ...(parsed.uncertaintyNote ? { uncertaintyNote: parsed.uncertaintyNote } : {}),
      artifacts,
    }
  }

  artifact(runId: string, taskId: string, artifactId: string): { path: string; name: string; mediaType: string } {
    const task = this.requireTask(runId, taskId)
    if (task.status !== 'SUCCEEDED') throw new Error('Artifact is available only for succeeded tasks')
    const entry = ARTIFACTS[artifactId]
    if (!entry) throw new Error('Artifact unavailable')
    const path = join(this.taskDir(runId, taskId), entry.name)
    this.ownedFileStat(path)
    return { path, name: entry.name, mediaType: entry.mediaType }
  }

  registerPrediction(runId: string, taskId: string, input: {
    prediction: string
    conditions?: string
    uncertainty?: string
    linkedExperiment?: string
  }): { task: ModelTask; predictionId: string } {
    const task = this.requireTask(runId, taskId)
    if (task.status !== 'SUCCEEDED') throw new Error('Only successful jobs can be registered as predictions')
    // The referenced result must actually be downloadable before it is claimed as evidence.
    this.artifact(runId, taskId, 'result')
    const payload = (input ?? {}) as Record<string, unknown>
    const prediction = this.text(payload.prediction, 'prediction', 2, 2000)
    const conditions = this.text(payload.conditions, 'conditions', 0, 500)
    const uncertainty = this.text(payload.uncertainty, 'uncertainty', 0, 500)
    const linkedExperiment = this.text(payload.linkedExperiment, 'linkedExperiment', 0, 500)

    if (task.predictionId) {
      // Idempotent: an already-registered job keeps its prediction record.
      if (linkedExperiment && task.linkedExperiment !== linkedExperiment) {
        this.linkExperiment(runId, taskId, { experimentRef: linkedExperiment })
      }
      return { task: this.get(runId, taskId), predictionId: task.predictionId }
    }

    const artifactRef = `/api/modeling/tasks/${task.id}/artifacts/result?runId=${encodeURIComponent(runId)}`
    const record = this.createPrediction(runId, {
      model: `${task.method} v${task.methodVersion}`,
      artifactRef,
      prediction,
      conditions: conditions || this.defaultConditions(task),
      uncertainty,
      linkedExperiment: '',
      reason: `Registered from modeling task ${task.id}`,
    })
    if (!record || typeof record.id !== 'string' || !record.id.trim()) {
      throw new Error('Prediction store did not return an id')
    }
    task.predictionId = record.id
    this.persistTask(task)
    if (linkedExperiment) this.linkExperiment(runId, taskId, { experimentRef: linkedExperiment })
    return { task: this.get(runId, taskId), predictionId: record.id }
  }

  linkExperiment(runId: string, taskId: string, input: { experimentRef: string; note?: string }): ModelTask {
    const task = this.requireTask(runId, taskId)
    if (!task.predictionId) throw new Error('Register a prediction before linking an experiment')
    const payload = (input ?? {}) as Record<string, unknown>
    const experimentRef = this.text(payload.experimentRef, 'experimentRef', 1, 500)
    const note = this.text(payload.note, 'note', 0, MAX_EXPERIMENT_NOTE)
    if (task.linkedExperiment && task.linkedExperiment !== experimentRef) {
      throw new Error('Task is already linked to a different experiment')
    }
    if (task.linkedExperiment !== experimentRef) {
      // Adapter updates the industrial store; linking never marks the prediction tested.
      this.linkPrediction?.(runId, task.predictionId, experimentRef, note)
      task.linkedExperiment = experimentRef
    }
    if (note) task.linkedExperimentNote = note
    this.persistTask(task)
    return clone(task)
  }

  async close(): Promise<void> {
    this.closed = true
    const jobs = [...this.active.values()]
    for (const [key, job] of this.active) {
      const task = this.tasks.get(key)
      if (task && task.status === 'RUNNING') {
        task.status = 'FAILED'
        task.error = 'Service shutdown'
        task.finishedAt = new Date().toISOString()
        this.persistTaskSafe(task)
      }
      this.terminate(job)
    }
    await this.awaitJobs(jobs, 3_000)
    for (const job of jobs) {
      try {
        if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGKILL')
      } catch { /* already gone */ }
    }
    await this.awaitJobs(jobs, 1_000)
  }

  // ------------------------------------------------------------------ validation

  private assertOpen(): void {
    if (this.closed) throw new Error('Modeling service is closed')
  }

  private validateBudget(value: unknown): ModelBudget {
    if (value === undefined || value === null) return { wallTimeMs: DEFAULT_WALL_MS, maxOutputRows: DEFAULT_OUTPUT_ROWS }
    if (!own(value)) throw new Error('budget must be an object')
    for (const name of Object.keys(value)) {
      if (name !== 'wallTimeMs' && name !== 'maxOutputRows') throw new Error(`budget contains unknown field ${name}`)
    }
    const wallTimeMs = value.wallTimeMs === undefined ? DEFAULT_WALL_MS : value.wallTimeMs
    const maxOutputRows = value.maxOutputRows === undefined ? DEFAULT_OUTPUT_ROWS : value.maxOutputRows
    if (!Number.isInteger(wallTimeMs) || (wallTimeMs as number) < MIN_WALL_MS || (wallTimeMs as number) > MAX_WALL_MS) {
      throw new Error(`wallTimeMs must be an integer between ${MIN_WALL_MS} and ${MAX_WALL_MS}`)
    }
    if (!Number.isInteger(maxOutputRows) || (maxOutputRows as number) < 2 || (maxOutputRows as number) > MAX_OUTPUT_ROWS) {
      throw new Error(`maxOutputRows must be an integer between 2 and ${MAX_OUTPUT_ROWS}`)
    }
    return { wallTimeMs: wallTimeMs as number, maxOutputRows: maxOutputRows as number }
  }

  private validateParameters(method: string, value: Record<string, unknown>): Record<string, unknown> {
    if (method === 'growth_fit') {
      if (Object.keys(value).length > 0) throw new Error('growth_fit does not accept parameters; provide a datasetId instead')
      return {}
    }
    for (const name of Object.keys(value)) {
      if (!(MONOD_KEYS as readonly string[]).includes(name)) throw new Error(`monod_batch received unknown parameter ${name}`)
    }
    const parameters: Record<string, number> = {
      initialBiomass: boundedNumber(value.initialBiomass, 'initialBiomass', MONOD_BOUNDS.initialBiomass),
      initialSubstrate: boundedNumber(value.initialSubstrate, 'initialSubstrate', MONOD_BOUNDS.initialSubstrate),
      muMax: boundedNumber(value.muMax, 'muMax', MONOD_BOUNDS.muMax),
      halfSaturation: boundedNumber(value.halfSaturation, 'halfSaturation', MONOD_BOUNDS.halfSaturation),
      yield: boundedNumber(value.yield, 'yield', MONOD_BOUNDS.yield),
      duration: boundedNumber(value.duration, 'duration', MONOD_BOUNDS.duration),
      timeStep: boundedNumber(value.timeStep, 'timeStep', MONOD_BOUNDS.timeStep),
    }
    if (parameters.timeStep! > parameters.duration!) throw new Error('timeStep must not exceed duration')
    const rows = expectedTrajectoryRows(parameters.duration!, parameters.timeStep!)
    if (rows > MAX_OUTPUT_ROWS) throw new Error('Requested trajectory exceeds the maximum output rows')
    return parameters
  }

  private text(value: unknown, name: string, minimum: number, maximum: number): string {
    if (value === undefined || value === null) {
      if (minimum > 0) throw new Error(`${name} is required`)
      return ''
    }
    if (typeof value !== 'string') throw new Error(`${name} must be text`)
    const trimmed = value.trim()
    if (trimmed.length < minimum || trimmed.length > maximum) {
      throw new Error(`${name} must be ${minimum}-${maximum} characters`)
    }
    return trimmed
  }

  private defaultConditions(task: ModelTask): string {
    const units: Record<string, string> = {
      initialBiomass: 'g/L', initialSubstrate: 'g/L', muMax: '1/h',
      halfSaturation: 'g/L', yield: 'g-biomass/g-substrate', duration: 'h', timeStep: 'h',
    }
    const parts = Object.entries(task.parameters).map(([key, value]) => `${key}=${String(value)} ${units[key] ?? ''}`.trim())
    if (task.datasetId) parts.push(`datasetId=${task.datasetId}`)
    return `method=${task.method} v${task.methodVersion}; ${parts.join('; ')}`.slice(0, 500)
  }

  // ------------------------------------------------------------------ datasets

  private loadDataset(runId: string, datasetId: string): { dataset: Dataset; rows: Array<{ time: number; biomass: number }> } {
    safeId(datasetId)
    const jsonPath = this.datasetJsonPath(runId, datasetId)
    if (!existsSync(jsonPath)) throw new Error('Dataset not found for this run')
    let raw: unknown
    try { raw = JSON.parse(this.readOwnedText(jsonPath)) } catch { throw new Error('Dataset record is invalid') }
    const dataset = normalizeDataset(raw, runId)
    if (!dataset || dataset.id !== datasetId) throw new Error('Dataset record is invalid')
    const parsed = parseCsv(this.readOwnedText(this.datasetCsvPath(runId, datasetId)))
    validateDatasetRows(parsed)
    if (parsed.rows.length !== dataset.rowCount) throw new Error('Dataset CSV does not match its record')
    const rows = parsed.rows.map((row, index) => {
      const time = Number(row.time)
      const biomass = Number(row.biomass)
      if (!Number.isFinite(time) || !Number.isFinite(biomass)) throw new Error(`Dataset row ${index + 2} is invalid`)
      return { time, biomass }
    })
    this.datasets.set(this.key(runId, dataset.id), dataset)
    return { dataset, rows }
  }

  private datasetRowsFor(task: ModelTask): Array<{ time: number; biomass: number }> {
    if (!task.datasetId) throw new Error('Task has no dataset')
    return this.loadDataset(task.runId, task.datasetId).rows
  }

  // ------------------------------------------------------------------ scheduler

  private key(runId: string, id: string): string {
    return `${runId}:${id}`
  }

  private persistTask(task: ModelTask): void {
    this.atomicWrite(this.taskJsonPath(task.runId, task.id), JSON.stringify(task))
  }

  private persistTaskSafe(task: ModelTask): void {
    try { this.persistTask(task) } catch { /* in-memory state remains authoritative for this process */ }
  }

  private nextQueued(): ModelTask | undefined {
    let best: ModelTask | undefined
    for (const task of this.tasks.values()) {
      if (task.status !== 'QUEUED') continue
      if (!best || task.createdAt < best.createdAt) best = task
    }
    return best
  }

  private pump(): void {
    if (this.closed) return
    while (this.active.size < this.concurrency) {
      const next = this.nextQueued()
      if (!next) return
      this.launch(next)
      if (next.status === 'QUEUED') return // defensive: never spin on a job that did not start
    }
  }

  private resolveWorkerScript(): string {
    if (this.workerScriptOverride) return this.workerScriptOverride
    const here = dirname(fileURLToPath(import.meta.url))
    const adjacent = join(here, 'worker.py')
    if (existsSync(adjacent)) return adjacent
    return resolve(here, '../../src/modeling/worker.py')
  }

  private launch(task: ModelTask): void {
    const key = this.key(task.runId, task.id)
    if (this.active.has(key) || this.closed) return

    let dir: string
    let csvPath: string
    let script: string
    let requestJson: string
    try {
      dir = this.taskDir(task.runId, task.id)
      this.cleanupArtifacts(dir)
      csvPath = join(dir, 'output.csv')
      this.assertNoSymlinkSegments(csvPath)
      script = this.resolveWorkerScript()
      if (!existsSync(script)) throw new Error(`Worker script not found: ${script}`)
      const datasetRows = task.method === 'growth_fit' ? this.datasetRowsFor(task) : []
      requestJson = JSON.stringify({ method: task.method, parameters: task.parameters, budget: task.budget, datasetRows, csvPath })
    } catch (error) {
      this.markFailed(task, `Failed to prepare worker job: ${err(error)}`)
      return
    }

    task.status = 'RUNNING'
    task.startedAt = new Date().toISOString()
    delete task.error
    delete task.finishedAt
    try {
      this.persistTask(task)
    } catch (error) {
      task.status = 'FAILED'
      task.error = `Failed to persist running task: ${err(error)}`
      task.finishedAt = new Date().toISOString()
      this.cleanupArtifacts(dir)
      this.persistTaskSafe(task)
      this.pump()
      return
    }

    let child: ChildProcess
    try {
      child = spawn(this.python, [script], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true })
    } catch (error) {
      this.markFailed(task, `Failed to spawn worker: ${err(error)}`)
      return
    }

    let resolveDone: () => void = () => {}
    const done = new Promise<void>(resolvePromise => { resolveDone = resolvePromise })
    const job: ActiveJob = {
      child, timer: undefined, killTimer: undefined, done, resolveDone,
      stdout: '', stderr: '', overflow: false, spawnError: undefined, exitCode: null, settled: false,
      finalize: () => {},
    }
    this.active.set(key, job)

    job.finalize = () => {
      if (job.settled) return
      job.settled = true
      if (job.timer) clearTimeout(job.timer)
      if (job.killTimer) clearTimeout(job.killTimer)
      this.active.delete(key)
      resolveDone()
      try { this.settle(task, job, dir, csvPath) } catch (error) { this.markFailed(task, err(error)) }
      this.pump()
    }

    // A missing interpreter or an early exit surfaces as an 'error'/'close' event;
    // neither may crash the server.
    child.on('error', error => {
      job.spawnError = error
      job.finalize()
    })
    child.on('close', code => {
      job.exitCode = code
      job.finalize()
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (job.overflow) return
      job.stdout += chunk.toString('utf8')
      if (job.stdout.length > MAX_STDOUT_CHARS) {
        job.overflow = true
        job.stdout = job.stdout.slice(0, MAX_STDOUT_CHARS)
        this.terminate(job)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (job.stderr.length >= MAX_STDERR_CHARS) return
      job.stderr += chunk.toString('utf8').slice(0, MAX_STDERR_CHARS - job.stderr.length)
    })
    child.stdin?.on('error', () => { /* handled by the child close/error path */ })

    job.timer = setTimeout(() => {
      try {
        if (job.settled || task.status !== 'RUNNING') return
        task.status = 'TIMED_OUT'
        task.error = 'Worker exceeded the wall time budget'
        task.finishedAt = new Date().toISOString()
        this.persistTaskSafe(task)
        this.terminate(job)
      } catch (error) {
        this.markFailed(task, `Failed to enforce the time budget: ${err(error)}`)
        this.terminate(job)
      }
    }, task.budget.wallTimeMs)
    job.timer.unref?.()

    try {
      child.stdin?.end(requestJson)
    } catch (error) {
      job.spawnError = job.spawnError ?? new Error(err(error))
      this.terminate(job)
    }
  }

  private terminate(job: ActiveJob): void {
    const child = job.child
    if (child.exitCode !== null || child.signalCode !== null) return
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    if (!job.killTimer) {
      job.killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        } catch { /* already gone */ }
      }, KILL_GRACE_MS)
      job.killTimer.unref?.()
    }
  }

  private settle(task: ModelTask, job: ActiveJob, dir: string, csvPath: string): void {
    try {
      if (task.status !== 'RUNNING') {
        this.cleanupArtifacts(dir)
        this.persistTaskSafe(task)
        return
      }
      if (job.spawnError) throw new Error(`Worker failed to start: ${job.spawnError.message}`)
      if (job.overflow) throw new Error('Worker produced more output than allowed')
      if (job.exitCode === null) throw new Error('Worker terminated before producing a result')
      if (job.exitCode !== 0) {
        const message = workerErrorMessage(job.stdout)
        throw new Error(message || job.stderr.trim().slice(0, 500) || `Worker exited with code ${job.exitCode}`)
      }
      if (job.stdout.length > MAX_WORKER_JSON_BYTES) throw new Error('Worker response is too large')
      const parsed = validateWorkerResult(JSON.parse(job.stdout), task)
      if (!existsSync(csvPath)) throw new Error('Worker output artifact is missing')
      this.validateTrajectory(task, csvPath, parsed)
      this.atomicWrite(join(dir, 'result.json'), JSON.stringify(parsed))
      task.methodVersion = parsed.methodVersion
      task.status = 'SUCCEEDED'
      delete task.error
      task.finishedAt = new Date().toISOString()
    } catch (error) {
      this.cleanupArtifacts(dir)
      task.status = 'FAILED'
      task.error = err(error).slice(0, 1000)
      task.finishedAt = new Date().toISOString()
    }
    this.persistTaskSafe(task)
  }

  private markFailed(task: ModelTask, message: string): void {
    task.status = 'FAILED'
    task.error = message.slice(0, 1000)
    task.finishedAt = new Date().toISOString()
    try { this.cleanupArtifacts(this.safeTaskDir(task.runId, task.id)) } catch { /* best effort */ }
    this.persistTaskSafe(task)
    this.pump()
  }

  private cleanupArtifacts(dir: string): void {
    for (const name of Object.keys(ARTIFACTS).map(id => ARTIFACTS[id]!.name)) {
      try { unlinkSync(join(dir, name)) } catch { /* best effort */ }
    }
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.tmp')) continue
        try { unlinkSync(join(dir, file)) } catch { /* best effort */ }
      }
    } catch { /* directory may not exist */ }
  }

  private safeTaskDir(runId: string, taskId: string): string {
    return join(this.kindDir(runId, 'tasks'), safeId(taskId))
  }

  // ------------------------------------------------------------------ result validation

  private validateTrajectory(task: ModelTask, csvPath: string, result: WorkerResult): void {
    const stat = this.ownedFileStat(csvPath)
    if (stat.size > MAX_ARTIFACT_BYTES) throw new Error('Worker output artifact is too large')
    const lines = readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    if (lines.length < 2) throw new Error('Worker output artifact has no data rows')
    const expectedHeader = task.method === 'monod_batch'
      ? ['time_h', 'biomass_g_L', 'substrate_g_L']
      : ['time_h', 'observed_biomass_g_L', 'fitted_biomass_g_L', 'log_residual']
    const header = lines[0]!.split(',').map(cell => cell.trim())
    if (header.length !== expectedHeader.length || header.some((cell, index) => cell !== expectedHeader[index])) {
      throw new Error('Worker output artifact header is invalid')
    }
    const rows = lines.slice(1).map((line, index) => {
      const cells = line.split(',')
      if (cells.length !== expectedHeader.length) throw new Error(`Worker output row ${index + 2} has the wrong column count`)
      const values = cells.map(cell => Number(cell))
      if (values.some(value => !Number.isFinite(value))) throw new Error(`Worker output row ${index + 2} is not finite`)
      return values
    })
    let previousTime = -Infinity
    for (const [index, row] of rows.entries()) {
      const time = row[0]!
      if (index > 0 && time <= previousTime) throw new Error('Worker output times are not strictly increasing')
      previousTime = time
    }

    if (task.method === 'monod_batch') {
      const initialBiomass = Number(task.parameters.initialBiomass)
      const initialSubstrate = Number(task.parameters.initialSubstrate)
      const yieldCoefficient = Number(task.parameters.yield)
      const pool = initialBiomass + yieldCoefficient * initialSubstrate
      for (const row of rows) {
        const biomass = row[1]!
        const substrate = row[2]!
        if (biomass < -1e-12 || substrate < -1e-12) throw new Error('Worker output contains negative concentrations')
        const residual = (biomass - initialBiomass) + yieldCoefficient * (substrate - initialSubstrate)
        if (Math.abs(residual) > 1e-7 * Math.max(1, pool)) throw new Error('Worker output violates X + Y*S mass balance')
      }
      const first = rows[0]!
      if (Math.abs(first[0]!) > 1e-9
        || Math.abs(first[1]! - initialBiomass) > 1e-9 * Math.max(1, pool)
        || Math.abs(first[2]! - initialSubstrate) > 1e-9 * Math.max(1, pool)) {
        throw new Error('Worker output does not start from the requested initial conditions')
      }
      const declaredRows = result.summary.outputRows
      if (!Number.isInteger(declaredRows) || rows.length !== declaredRows) {
        throw new Error('Worker output row count does not match its summary')
      }
      const finalBiomass = Number(result.summary.finalBiomass)
      const last = rows.at(-1)!
      if (!Number.isFinite(finalBiomass) || Math.abs(last[1]! - finalBiomass) > 1e-9 * Math.max(1, pool)) {
        throw new Error('Worker output does not match its reported final biomass')
      }
    } else {
      const declaredRows = result.summary.n
      if (!Number.isInteger(declaredRows) || rows.length !== declaredRows) {
        throw new Error('Worker fitted row count does not match its summary')
      }
      for (const row of rows) {
        if (row[1]! <= 0 || row[2]! <= 0) throw new Error('Worker fitted output must stay positive')
      }
    }
  }

  // ------------------------------------------------------------------ recovery

  private recover(): void {
    let runs: Dirent[] = []
    try { runs = readdirSync(this.realRoot, { withFileTypes: true }) } catch { return }
    for (const run of runs) {
      // `isDirectory()` is false for a symlink, so a symlinked run is never followed.
      if (!run.isDirectory() || !ID_RE.test(run.name)) continue
      let files: string[] = []
      try { files = readdirSync(this.readOwnedDir(join(this.realRoot, run.name, 'tasks'))) } catch { continue }
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const id = file.slice(0, -'.json'.length)
        if (!ID_RE.test(id)) continue
        let raw: unknown
        try { raw = JSON.parse(this.readOwnedText(join(this.realRoot, run.name, 'tasks', file))) } catch { continue }
        const task = this.normalizePersistedTask(run.name, id, raw)
        if (!task) continue
        if (task.status === 'SUCCEEDED' && !this.validateStoredResult(task)) {
          task.status = 'FAILED'
          task.error = 'Stored result is missing or invalid'
          task.finishedAt = new Date().toISOString()
          this.cleanupArtifacts(this.safeTaskDir(task.runId, task.id))
        }
        this.persistTaskSafe(task)
        this.tasks.set(this.key(task.runId, task.id), task)
      }
    }
    setImmediate(() => this.pump())
  }

  private normalizePersistedTask(runId: string, id: string, value: unknown): ModelTask | undefined {
    if (!own(value)) return undefined
    if (value.runId !== runId || value.id !== id) return undefined
    const method = typeof value.method === 'string' ? value.method : ''
    const definition = METHOD_BY_ID.get(method)
    const status = value.status
    if (!definition || typeof status !== 'string' || !STATUSES.has(status as ModelStatus)) return undefined

    const task: ModelTask = {
      id, runId, method, methodVersion: definition.version,
      title: typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 120) : method,
      status: status as ModelStatus,
      parameters: own(value.parameters) ? value.parameters : {},
      budget: { wallTimeMs: DEFAULT_WALL_MS, maxOutputRows: DEFAULT_OUTPUT_ROWS },
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    }
    if (typeof value.datasetId === 'string') task.datasetId = value.datasetId
    if (typeof value.methodVersion === 'string' && value.methodVersion) task.methodVersion = value.methodVersion
    if (typeof value.startedAt === 'string') task.startedAt = value.startedAt
    if (typeof value.finishedAt === 'string') task.finishedAt = value.finishedAt
    if (typeof value.error === 'string') task.error = value.error
    if (typeof value.predictionId === 'string') task.predictionId = value.predictionId
    if (typeof value.linkedExperiment === 'string') task.linkedExperiment = value.linkedExperiment
    if (typeof value.linkedExperimentNote === 'string') task.linkedExperimentNote = value.linkedExperimentNote

    try {
      task.parameters = this.validateParameters(method, task.parameters)
      task.budget = this.validateBudget(value.budget)
      if (task.methodVersion !== definition.version) throw new Error('method version is not recognized')
      if (task.method === 'growth_fit') {
        const { rows } = this.loadDataset(runId, task.datasetId ?? '')
        if (rows.length < 3) throw new Error('dataset has fewer than 3 points')
      }
    } catch (error) {
      task.status = 'FAILED'
      task.error = `Persisted task is invalid: ${err(error)}`.slice(0, 1000)
      task.finishedAt = new Date().toISOString()
      return task
    }

    // A job persisted as RUNNING has no live child after a restart; never resume it.
    if (task.status === 'RUNNING') {
      task.status = 'FAILED'
      task.error = 'Interrupted by service restart'
      task.finishedAt = new Date().toISOString()
    }
    return task
  }

  private validateStoredResult(task: ModelTask): boolean {
    try {
      const dir = this.taskDir(task.runId, task.id)
      const parsed = validateWorkerResult(JSON.parse(this.readOwnedText(join(dir, 'result.json'))), task)
      this.validateTrajectory(task, join(dir, 'output.csv'), parsed)
      return true
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------------ owned paths

  private validateRun(runId: string): void {
    this.validateRunId(runId)
    safeId(runId)
  }

  private lexical(path: string): string {
    const resolved = resolve(path)
    if (resolved !== this.realRoot && !resolved.startsWith(this.realRoot + sep)) {
      throw new Error('Path escaped the modeling data root')
    }
    return resolved
  }

  private assertNoSymlinkSegments(path: string): void {
    const resolved = this.lexical(path)
    const rel = relative(this.realRoot, resolved)
    if (!rel) return
    let current = this.realRoot
    for (const segment of rel.split(sep)) {
      if (!segment || segment === '.') continue
      current = join(current, segment)
      let stat: Stats
      try { stat = lstatSync(current) } catch (error) { if (isErrno(error, 'ENOENT')) return; throw error }
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed under the modeling data root')
    }
  }

  private ensureOwnedDir(path: string): string {
    const resolved = this.lexical(path)
    const rel = relative(this.realRoot, resolved)
    let current = this.realRoot
    for (const segment of rel.split(sep)) {
      if (!segment || segment === '.') continue
      current = join(current, segment)
      let stat: Stats
      try {
        stat = lstatSync(current)
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
        mkdirSync(current)
        stat = lstatSync(current)
      }
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed under the modeling data root')
      if (!stat.isDirectory()) throw new Error('Modeling data path component is not a directory')
    }
    return resolved
  }

  private readOwnedDir(path: string): string {
    const resolved = this.lexical(path)
    this.assertNoSymlinkSegments(resolved)
    const stat = lstatSync(resolved)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Modeling data path is not a directory')
    return resolved
  }

  private ownedFileStat(path: string): Stats {
    const resolved = this.lexical(path)
    this.assertNoSymlinkSegments(resolved)
    const stat = lstatSync(resolved)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Modeling data path is not a regular file')
    return stat
  }

  private readOwnedText(path: string): string {
    const resolved = this.lexical(path)
    this.assertNoSymlinkSegments(resolved)
    const stat = lstatSync(resolved)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Modeling data path is not a regular file')
    return readFileSync(resolved, 'utf8')
  }

  private atomicWrite(path: string, data: string): void {
    const target = this.lexical(path)
    this.ensureOwnedDir(dirname(target))
    this.assertNoSymlinkSegments(target)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temporary, target)
      const stat = lstatSync(target)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Modeling write did not produce a regular file')
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* already renamed or never created */ }
      throw error
    }
  }

  private runDir(runId: string): string {
    this.validateRun(runId)
    return this.ensureOwnedDir(join(this.realRoot, runId))
  }

  private kindDir(runId: string, kind: string): string {
    return this.ensureOwnedDir(join(this.runDir(runId), kind))
  }

  private taskDir(runId: string, taskId: string): string {
    safeId(taskId)
    return this.ensureOwnedDir(join(this.kindDir(runId, 'tasks'), taskId))
  }

  private taskJsonPath(runId: string, taskId: string): string {
    safeId(taskId)
    return join(this.kindDir(runId, 'tasks'), `${taskId}.json`)
  }

  private datasetDir(runId: string): string {
    return this.kindDir(runId, 'datasets')
  }

  private datasetJsonPath(runId: string, datasetId: string): string {
    safeId(datasetId)
    return join(this.datasetDir(runId), `${datasetId}.json`)
  }

  private datasetCsvPath(runId: string, datasetId: string): string {
    safeId(datasetId)
    return join(this.datasetDir(runId), `${datasetId}.csv`)
  }

  private requireTask(runId: string, taskId: string): ModelTask {
    this.validateRun(runId)
    safeId(taskId)
    const task = this.tasks.get(this.key(runId, taskId))
    if (!task) throw new Error('Task not found for this run')
    return task
  }

  private async awaitJobs(jobs: ActiveJob[], ms: number): Promise<void> {
    if (jobs.length === 0) return
    await Promise.race([Promise.all(jobs.map(job => job.done)), delay(ms)])
  }
}
