import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { batchSchema, correctionSchema, metricSchema, recordSchema, roundSchema } from './types.js'
import type { Batch, Catalogue, Comparison, ImportPreview, Metric, Observation, RecordPage, Revision, Round } from './types.js'
import { CSV_HEADERS, parseCsv, writeCsv } from './csv.js'

const uid = () => randomUUID()
const now = () => new Date().toISOString()
/** Exact base-10 subtraction; storage and comparison never round through a float. */
export function subtract(a: string, b: string): string {
  const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0)
  const integer = (x: string) => {
    const [whole, fraction = ''] = x.replace(/^-/, '').split('.')
    return BigInt(whole! + fraction.padEnd(scale, '0')) * (x.startsWith('-') ? -1n : 1n)
  }
  const result = integer(a) - integer(b)
  const digits = (result < 0n ? -result : result).toString().padStart(scale + 1, '0')
  const value = scale ? (digits.slice(0, -scale) + '.' + digits.slice(-scale)).replace(/\.?0+$/, '') : digits
  return (result < 0n ? '-' : '') + value
}
const less = (a: string, b: string) => subtract(a, b).startsWith('-')
const sameInput = (a: Observation, b: ReturnType<typeof recordSchema.parse>) =>
  Object.keys(b).every(key => a[key as keyof Observation] === b[key as keyof typeof b])

/** One plugin-owned SQLite database, with project isolation on every lookup. */
export class BatchDataStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rounds(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, number INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(project_id,number));
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, round_id TEXT NOT NULL REFERENCES rounds(id), code TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(round_id,code));
      CREATE TABLE IF NOT EXISTS metrics(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, code TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(project_id,code));
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, batch_id TEXT NOT NULL REFERENCES batches(id), metric_id TEXT NOT NULL REFERENCES metrics(id), sample TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(batch_id,metric_id,sample));
      CREATE TABLE IF NOT EXISTS revisions(record_id TEXT NOT NULL REFERENCES records(id), revision INTEGER NOT NULL, project_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(record_id,revision));
      CREATE INDEX IF NOT EXISTS records_project ON records(project_id,batch_id,metric_id);
      CREATE INDEX IF NOT EXISTS revisions_project ON revisions(project_id,record_id);`)
  }
  close() { this.db.close() }
  private transaction<T>(f: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = f(); this.db.exec('COMMIT'); return value } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private rows<T>(sql: string, ...args: Array<string | number>): T[] {
    return (this.db.prepare(sql).all(...args) as { payload: string }[]).map(row => JSON.parse(row.payload) as T)
  }
  private item<T>(table: 'rounds' | 'batches' | 'metrics' | 'records', project: string, id: string): T {
    const row = this.db.prepare(`SELECT payload FROM ${table} WHERE project_id=? AND id=?`).get(project, id) as { payload: string } | undefined
    if (!row) throw new Error('记录不存在或不属于当前项目。')
    return JSON.parse(row.payload) as T
  }
  catalogue(project: string): Catalogue {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE project_id=?').get(project) as { n: number }
    return { rounds: this.rows<Round>('SELECT payload FROM rounds WHERE project_id=? ORDER BY number', project),
      batches: this.rows<Batch>('SELECT payload FROM batches WHERE project_id=? ORDER BY rowid', project),
      metrics: this.rows<Metric>('SELECT payload FROM metrics WHERE project_id=? ORDER BY code', project), recordCount: count.n }
  }
  addRound(project: string, run: string, raw: unknown): Round {
    const input = roundSchema.parse(raw)
    if (this.db.prepare('SELECT id FROM rounds WHERE project_id=? AND number=?').get(project, input.number)) throw new Error('该轮次编号已存在。')
    const item: Round = { ...input, id: uid(), projectId: project, runId: run, createdAt: now() }
    this.db.prepare('INSERT INTO rounds VALUES(?,?,?,?)').run(item.id, project, item.number, JSON.stringify(item))
    return item
  }
  addBatch(project: string, run: string, raw: unknown): Batch {
    const input = batchSchema.parse(raw); this.item('rounds', project, input.roundId)
    if (this.db.prepare('SELECT id FROM batches WHERE project_id=? AND round_id=? AND code=?').get(project, input.roundId, input.code)) throw new Error('该轮次中的批次编号已存在。')
    const item: Batch = { ...input, id: uid(), projectId: project, runId: run, createdAt: now() }
    this.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?)').run(item.id, project, input.roundId, input.code, JSON.stringify(item))
    return item
  }
  addMetric(project: string, raw: unknown): Metric {
    const input = metricSchema.parse(raw)
    if (input.lower !== null && input.upper !== null && less(input.upper, input.lower)) throw new Error('正常范围下限不能大于上限。')
    if (this.db.prepare('SELECT id FROM metrics WHERE project_id=? AND code=?').get(project, input.code)) throw new Error('该指标代码已存在。')
    const item: Metric = { ...input, id: uid(), projectId: project }
    this.db.prepare('INSERT INTO metrics VALUES(?,?,?,?)').run(item.id, project, input.code, JSON.stringify(item))
    return item
  }
  private validate(project: string, raw: unknown) {
    const input = recordSchema.parse(raw)
    this.item('batches', project, input.batchId)
    const metric = this.item<Metric>('metrics', project, input.metricId)
    if (metric.unit !== input.unit) throw new Error(`单位不匹配：指标 ${metric.code} 要求 ${metric.unit || '无量纲'}，收到 ${input.unit || '无量纲'}。`)
    const deviation = (metric.lower !== null && less(input.value, metric.lower)) || (metric.upper !== null && less(metric.upper, input.value))
    return { input, deviation }
  }
  private existing(project: string, input: ReturnType<typeof recordSchema.parse>) {
    return this.rows<Observation>('SELECT payload FROM records WHERE project_id=? AND batch_id=? AND metric_id=? AND sample=?', project, input.batchId, input.metricId, input.sample)[0]
  }
  private insert(project: string, run: string, raw: unknown, actor: string): { item: Observation; duplicate: boolean } {
    const { input, deviation } = this.validate(project, raw)
    const existing = this.existing(project, input)
    if (existing) {
      if (sameInput(existing, input)) return { item: existing, duplicate: true }
      throw new Error('该批次、采样点和指标已有记录；使用修正功能并填写原因，不能覆盖原值。')
    }
    const timestamp = now()
    const item: Observation = { ...input, id: uid(), projectId: project, runId: run, deviation, revision: 1, createdAt: timestamp, updatedAt: timestamp }
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, project, item.batchId, item.metricId, item.sample, 1, JSON.stringify(item))
    this.saveRevision(item, actor, '首次记录')
    return { item, duplicate: false }
  }
  previewRecord(project: string, raw: unknown) {
    const { input, deviation } = this.validate(project, raw)
    const batch = this.item<Batch>('batches', project, input.batchId)
    const metric = this.item<Metric>('metrics', project, input.metricId)
    const existing = this.existing(project, input)
    if (existing && !sameInput(existing, input)) throw new Error('该采样点已有不同记录，请使用修正工具。')
    return { input, deviation, batch, metric }
  }
  record(project: string, run: string, raw: unknown, actor = 'local-user') { return this.transaction(() => this.insert(project, run, raw, actor)) }
  private saveRevision(item: Observation, actor: string, reason: string) {
    const revision: Revision = { recordId: item.id, revision: item.revision, actor, reason, at: item.updatedAt, data: item }
    this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(item.id, item.revision, item.projectId, JSON.stringify(revision))
  }
  correct(project: string, id: string, raw: unknown, actor = 'local-user'): Observation {
    return this.transaction(() => {
      const input = correctionSchema.parse(raw)
      const previous = this.item<Observation>('records', project, id)
      if (previous.revision !== input.expectedRevision) throw new Error('记录已被其他操作修改，请刷新后核对最新版本。')
      const { expectedRevision: _, reason, ...fields } = input
      const { deviation } = this.validate(project, { ...Object.fromEntries(Object.keys(recordSchema.shape).map(key => [key, previous[key as keyof Observation]])), ...fields })
      const item: Observation = { ...previous, ...fields, deviation, revision: previous.revision + 1, updatedAt: now() }
      this.db.prepare('UPDATE records SET revision=?,payload=? WHERE project_id=? AND id=? AND revision=?')
        .run(item.revision, JSON.stringify(item), project, id, previous.revision)
      this.saveRevision(item, actor, reason)
      return item
    })
  }
  history(project: string, id: string): Revision[] {
    this.item('records', project, id)
    return this.rows<Revision>('SELECT payload FROM revisions WHERE project_id=? AND record_id=? ORDER BY revision DESC', project, id)
  }
  records(project: string, filter: { batchId?: string | undefined; metricId?: string | undefined; sample?: string | undefined; offset?: number; limit?: number } = {}): RecordPage {
    if (filter.batchId) this.item('batches', project, filter.batchId)
    if (filter.metricId) this.item('metrics', project, filter.metricId)
    const where = ['project_id=?']; const args: Array<string | number> = [project]
    for (const [key, col] of [['batchId', 'batch_id'], ['metricId', 'metric_id'], ['sample', 'sample']] as const) {
      if (filter[key]) { where.push(`${col}=?`); args.push(filter[key]!) }
    }
    const limit = Math.min(500, Math.max(1, Math.floor(filter.limit ?? 100)))
    const offset = Math.max(0, Math.floor(filter.offset ?? 0))
    const clause = where.join(' AND ')
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${clause}`).get(...args) as { n: number }).n
    return { items: this.rows<Observation>(`SELECT payload FROM records WHERE ${clause} ORDER BY rowid DESC LIMIT ? OFFSET ?`, ...args, limit, offset), total, offset, limit }
  }
  private importRows(project: string, batchId: string, csv: string) {
    this.item('batches', project, batchId)
    if (typeof csv !== 'string' || csv.length > 1_000_000) throw new Error('CSV 内容最多 1 MB。')
    const parsed = parseCsv(csv)
    const header = parsed.shift()?.map(x => x.trim())
    if (!header || new Set(header).size !== header.length || CSV_HEADERS.slice(0, 5).some(x => !header.includes(x)) || header.some(x => !CSV_HEADERS.includes(x))) throw new Error(`CSV 列名使用：${CSV_HEADERS.join(',')}；前五列必填。`)
    if (!parsed.length || parsed.length > 2000) throw new Error('一次导入 1–2000 条记录。')
    const metrics = this.catalogue(project).metrics
    return parsed.map((cells, i) => {
      const values = Object.fromEntries(header.map((h, j) => [h, cells[j] ?? '']))
      const raw = { batchId, sample: values.sample, metricId: metrics.find(x => x.code === values.metric)?.id ?? '', value: values.value,
        unit: values.unit, source: values.source, locator: values.locator ?? '', note: values.note ?? '', sampledAt: values.sampledAt || null }
      return { line: i + 2, raw, columnError: cells.length !== header.length }
    })
  }
  preview(project: string, batchId: string, csv: string): ImportPreview {
    const seen = new Set<string>()
    const rows: ImportPreview['rows'] = this.importRows(project, batchId, csv).map(({ line, raw, columnError }) => {
      try {
        if (columnError) throw new Error('列数与表头不一致。')
        const { input, deviation } = this.validate(project, raw)
        const key = JSON.stringify([input.sample, input.metricId])
        if (seen.has(key)) throw new Error('CSV 内同一采样点和指标重复，请先合并或修正。')
        seen.add(key)
        const existing = this.existing(project, input)
        if (existing && !sameInput(existing, input)) throw new Error('与已有记录冲突，需使用修正功能。')
        return { line, status: existing ? 'duplicate' : 'new', deviation, message: existing ? '与已有记录完全相同，将跳过' : deviation ? '超出正常范围，保留原值并标记偏差' : '可以导入' }
      } catch (error) { return { line, status: 'error', message: error instanceof Error ? error.message : String(error) } }
    })
    return { rows, newCount: rows.filter(x => x.status === 'new').length, duplicateCount: rows.filter(x => x.status === 'duplicate').length, errorCount: rows.filter(x => x.status === 'error').length }
  }
  import(project: string, run: string, batchId: string, csv: string, actor = 'local-user') {
    return this.transaction(() => {
      const preview = this.preview(project, batchId, csv)
      if (preview.errorCount) throw new Error(`导入未写入：${preview.errorCount} 行未通过校验。请先预览并修正。`)
      for (const row of this.importRows(project, batchId, csv)) this.insert(project, run, row.raw, actor)
      return { inserted: preview.newCount, skipped: preview.duplicateCount }
    })
  }
  compare(project: string, leftId: string, rightId: string): Comparison {
    if (leftId === rightId) throw new Error('请选择两个不同批次。')
    const left = this.item<Batch>('batches', project, leftId), right = this.item<Batch>('batches', project, rightId)
    const rows = (id: string) => this.rows<Observation>('SELECT payload FROM records WHERE project_id=? AND batch_id=? ORDER BY sample,metric_id', project, id)
    const a = rows(leftId), b = rows(rightId)
    if (a.length + b.length > 10000) throw new Error('对比最多支持合计 10000 条记录，请先导出按指标分析。')
    const key = (x: Observation) => JSON.stringify([x.metricId, x.sample])
    const am = new Map(a.map(x => [key(x), x])), bm = new Map(b.map(x => [key(x), x]))
    const metrics = new Map(this.catalogue(project).metrics.map(x => [x.id, x]))
    const items: Comparison['items'] = [...new Set([...am.keys(), ...bm.keys()])].map(k => {
      const l = am.get(k) ?? null, r = bm.get(k) ?? null
      const metric = metrics.get((l ?? r)!.metricId)!
      return { metric, sample: (l ?? r)!.sample, left: l, right: r, delta: l && r ? subtract(r.value, l.value) : null, status: l && r ? 'matched' : 'missing' }
    })
    return { left, right, items, matched: items.filter(x => x.status === 'matched').length, missing: items.filter(x => x.status === 'missing').length }
  }
  export(project: string, batchId: string): string {
    this.item('batches', project, batchId)
    const metrics = new Map(this.catalogue(project).metrics.map(m => [m.id, m.code]))
    const rows = this.rows<Observation>('SELECT payload FROM records WHERE project_id=? AND batch_id=? ORDER BY rowid', project, batchId)
    return writeCsv([CSV_HEADERS, ...rows.map(r => [r.sample, metrics.get(r.metricId)!, r.value, r.unit, r.source, r.locator, r.sampledAt ?? '', r.note])])
  }
}
