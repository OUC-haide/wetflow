import type { ModelMethod, ModelResult, ModelTask } from '../modeling/types.js'

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])

export const STATUS_LABELS: Record<string, string> = {
  QUEUED: '排队中',
  RUNNING: '运行中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  TIMED_OUT: '超时',
}

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

/** Must stay in sync with `MAX_CSV` in src/modeling/service.ts. */
export const CSV_MAX_BYTES = 2_000_000
export const PREDICTION_MIN = 2
export const PREDICTION_MAX = 2000
export const CONDITIONS_MAX = 500
export const UNCERTAINTY_MAX = 500
export const EXPERIMENT_REF_MAX = 500
/** Documented fallback; the live value comes from `methods().limits.maxExperimentNote` (600 in the frozen service). */
export const EXPERIMENT_NOTE_MAX = 600
export const BUDGET_OPTIONS = [5, 30, 60, 120] as const
export const MAX_OUTPUT_ROWS = 20_001
export const DEFAULT_MAX_OUTPUT_ROWS = 5_000

const FIELD_LABELS: Record<string, string> = {
  initialBiomass: '初始生物量 X₀',
  initialSubstrate: '初始底物 S₀',
  muMax: '最大比生长速率 μmax',
  halfSaturation: '半饱和常数 Ks',
  yield: '生物量产率 Yx/s',
  duration: '模拟时长',
  timeStep: '积分步长',
}

const FIELD_UNITS: Record<string, string> = {
  initialBiomass: 'g/L',
  initialSubstrate: 'g/L',
  muMax: '1/h',
  halfSaturation: 'g/L',
  yield: 'g-biomass/g-substrate',
  duration: 'h',
  timeStep: 'h',
}

const FIELD_EXAMPLES: Record<string, string> = {
  initialBiomass: '0.1',
  initialSubstrate: '10',
  muMax: '0.4',
  halfSaturation: '0.1',
  yield: '0.5',
  duration: '24',
  timeStep: '0.1',
}

export interface FieldSpec {
  key: string
  label: string
  unit: string
  required: boolean
  minimum?: number
  exclusiveMinimum?: number
  example: string
}

interface JsonProperty {
  type?: unknown
  unit?: unknown
  minimum?: unknown
  exclusiveMinimum?: unknown
}

interface JsonSchema {
  properties?: Record<string, JsonProperty>
  required?: unknown
}

/**
 * Derive numeric form fields from the backend method metadata so units and
 * bounds always follow the service schema instead of a hardcoded copy.
 */
export function methodFields(method: ModelMethod | undefined): FieldSpec[] {
  const schema = (method?.inputSchema ?? {}) as JsonSchema
  const properties = schema.properties ?? {}
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [],
  )
  const fields: FieldSpec[] = []
  for (const [key, property] of Object.entries(properties)) {
    if (key === 'datasetId' || property?.type !== 'number') continue
    const spec: FieldSpec = {
      key,
      label: FIELD_LABELS[key] ?? key,
      unit: typeof property.unit === 'string' ? property.unit : FIELD_UNITS[key] ?? '',
      required: required.has(key),
      example: FIELD_EXAMPLES[key] ?? '',
    }
    if (typeof property.minimum === 'number') spec.minimum = property.minimum
    if (typeof property.exclusiveMinimum === 'number') spec.exclusiveMinimum = property.exclusiveMinimum
    fields.push(spec)
  }
  return fields
}

export function fieldUnit(key: string): string {
  return FIELD_UNITS[key] ?? ''
}

export interface ParameterValidation {
  values: Record<string, number>
  errors: Record<string, string>
}

export function validateParameters(fields: readonly FieldSpec[], raw: Record<string, string>): ParameterValidation {
  const values: Record<string, number> = {}
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const text = (raw[field.key] ?? '').trim()
    if (!text) {
      if (field.required) errors[field.key] = '必填'
      continue
    }
    const value = Number(text)
    if (!Number.isFinite(value)) {
      errors[field.key] = '请输入有限数值'
      continue
    }
    if (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum) {
      errors[field.key] = `必须大于 ${field.exclusiveMinimum}`
      continue
    }
    if (field.minimum !== undefined && value < field.minimum) {
      errors[field.key] = `不能小于 ${field.minimum}`
      continue
    }
    values[field.key] = value
  }
  return { values, errors }
}

/** Mirrors the service's `expectedTrajectoryRows` so the budget request matches the worker output bound. */
export function expectedTrajectoryRows(duration: number | undefined, timeStep: number | undefined): number | undefined {
  if (duration === undefined || timeStep === undefined || !(duration > 0) || !(timeStep > 0)) return undefined
  return Math.max(2, Math.ceil(duration / timeStep - 1e-9) + 1)
}

export function formatNumber(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const magnitude = Math.abs(value)
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e6)) return value.toExponential(3)
  return String(Number(value.toPrecision(8)))
}

export function formatValue(value: unknown, unit?: string): string {
  let rendered: string
  if (value === null || value === undefined) rendered = '—'
  else if (typeof value === 'boolean') rendered = value ? '是' : '否'
  else if (typeof value === 'number') rendered = formatNumber(value)
  else if (typeof value === 'string') rendered = value || '—'
  else rendered = JSON.stringify(value)
  return unit && rendered !== '—' ? `${rendered} ${unit}` : rendered
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Concise, honest default prediction text derived from the actual result.
 * Fit diagnostics are deliberately not described as uncertainty.
 */
export function draftPrediction(task: ModelTask, result: ModelResult): string {
  const summary = result.summary ?? {}
  if (result.method === 'monod_batch') {
    const finalBiomass = numberOf(summary.finalBiomass)
    const finalSubstrate = numberOf(summary.finalSubstrate)
    const initialBiomass = numberOf(task.parameters.initialBiomass)
    const initialSubstrate = numberOf(task.parameters.initialSubstrate)
    return (
      `Monod 批次模拟（${task.method} v${result.methodVersion}）预测：终点生物量 ${formatNumber(finalBiomass)} g/L，` +
      `终点底物 ${formatNumber(finalSubstrate)} g/L（初始 X=${formatNumber(initialBiomass)} g/L、S=${formatNumber(initialSubstrate)} g/L）。` +
      '模型预测，不是实验测量。'
    )
  }
  const growthRate = numberOf(result.metrics?.growthRate) ?? numberOf(summary.growthRate)
  const doublingTime = numberOf(summary.doublingTime)
  return (
    `指数生长期 log-linear 拟合（${task.method} v${result.methodVersion}）预测：比生长速率 μ=${formatNumber(growthRate)} 1/h` +
    `${doublingTime === undefined ? '（斜率非正，未给出倍增时间）' : `，倍增时间 ${formatNumber(doublingTime)} h`}。` +
    '基于用户自行选定的指数期数据；rSquared/logRmse 是拟合诊断，不是不确定度。'
  )
}

/** Concise reproduction conditions: method/version plus the exact requested parameters and units. */
export function draftConditions(task: ModelTask, method: ModelMethod | undefined, datasetName: string | undefined): string {
  const fields = methodFields(method)
  const parts = fields
    .filter(field => task.parameters[field.key] !== undefined)
    .map(field => `${field.label}(${field.key})=${formatNumber(task.parameters[field.key])}${field.unit ? ` ${field.unit}` : ''}`)
  if (task.datasetId) parts.push(`数据集=${datasetName ?? task.datasetId}`)
  const prefix = `方法=${task.method} v${task.methodVersion}`
  return (parts.length ? `${prefix}；${parts.join('；')}` : prefix).slice(0, CONDITIONS_MAX)
}

export interface ParsedTable {
  headers: string[]
  rows: string[][]
}

/** Small RFC4180-style parser for the worker's CSV artifacts (numeric, unquoted in practice). */
export function parseCsv(text: string): ParsedTable {
  const source = text.replace(/^\uFEFF/, '')
  const records: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      records.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    records.push(row)
  }
  const nonEmpty = records.filter(record => record.some(cell => cell.trim() !== ''))
  const first = nonEmpty[0]
  if (!first) return { headers: [], rows: [] }
  const headers = first.map(header => header.trim())
  const rows = nonEmpty.slice(1).map(record => headers.map((_, index) => (record[index] ?? '').trim()))
  return { headers, rows }
}

export interface TrajectorySeries {
  name: string
  values: number[]
}

export interface TrajectoryData {
  headers: string[]
  rows: string[][]
  time: number[]
  series: TrajectorySeries[]
  /** Numeric columns intentionally left out of the shared y-axis (for example a log residual). */
  omitted: string[]
  /** Common unit of the plotted series, derived from the worker's `name_unit` header convention. */
  yUnit?: string
}

/**
 * Columns whose scale cannot share the concentration axis. The worker writes
 * `log_residual` (ln g/L, dimensionless around zero) next to `*_g_L` columns.
 */
const AUXILIARY_SERIES = /(^|_)(log|residual)/i

/** Best-effort unit taken from the worker's `name_unit` CSV header convention. */
export function unitFromHeader(name: string): string | undefined {
  if (/_g[_-]?l$/i.test(name)) return 'g/L'
  if (/(_1[_-]?h|_per[_-]?h)$/i.test(name)) return '1/h'
  if (/_h$/i.test(name)) return 'h'
  return undefined
}

export function buildTrajectory(table: ParsedTable, maxSeries = 3): TrajectoryData | undefined {
  if (table.headers.length < 2 || table.rows.length === 0) return undefined
  const time = table.rows.map(row => Number(row[0]))
  if (!time.every(Number.isFinite)) return undefined
  const series: TrajectorySeries[] = []
  const omitted: string[] = []
  for (let column = 1; column < table.headers.length; column += 1) {
    const name = table.headers[column] ?? `column_${column}`
    const values = table.rows.map(row => Number(row[column]))
    if (!values.every(Number.isFinite)) continue
    // Keep incompatible scales (for example log_residual) off the shared axis;
    // they remain available in the data table and the CSV download.
    if (AUXILIARY_SERIES.test(name) || series.length >= maxSeries) {
      omitted.push(name)
      continue
    }
    series.push({ name, values })
  }
  if (series.length === 0) return undefined
  const units = series.map(item => unitFromHeader(item.name))
  const yUnit = units[0] !== undefined && units.every(unit => unit === units[0]) ? units[0] : undefined
  return {
    headers: table.headers,
    rows: table.rows,
    time,
    series,
    omitted,
    ...(yUnit ? { yUnit } : {}),
  }
}

export function seriesColor(index: number): string {
  const palette = ['#2f6fb0', '#c2622f', '#3f8f5f']
  return palette[index % palette.length] ?? '#2f6fb0'
}
