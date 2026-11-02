import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { batchSchema, correctionSchema, metricSchema, recordSchema, roundSchema } from './types.js'
import type { Batch, Catalogue, Comparison, ImportPreview, Metric, Observation, RecordPage, Revision, Round } from './types.js'
import { CSV_HEADERS, parseCsv, writeCsv } from './csv.js'
import { managementRequestSchema, preparedManagementSchema, describeManagementChange, appendManagementNote } from './management.js'
import type { ManagementChange, ManagementEntry, ManagementRequest } from './management.js'
import { overviewSchema, overviewTable, type OverviewRow } from './overview.js'

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
    this.db.exec(`CREATE TABLE IF NOT EXISTS project_revisions(project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS management_history(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS management_project ON management_history(project_id);`)
  }
  close() { this.db.close() }
  private changed(project: string) {
    this.db.prepare('INSERT INTO project_revisions VALUES(?,1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1').run(project)
  }
  private revision(project: string): number {
    return (this.db.prepare('SELECT revision FROM project_revisions WHERE project_id=?').get(project) as { revision: number } | undefined)?.revision ?? 0
  }
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
    this.changed(project)
    return item
  }
  addBatch(project: string, run: string, raw: unknown): Batch {
    const input = batchSchema.parse(raw); this.item('rounds', project, input.roundId)
    if (this.db.prepare('SELECT id FROM batches WHERE project_id=? AND round_id=? AND code=?').get(project, input.roundId, input.code)) throw new Error('该轮次中的批次编号已存在。')
    const item: Batch = { ...input, id: uid(), projectId: project, runId: run, createdAt: now() }
    this.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?)').run(item.id, project, input.roundId, input.code, JSON.stringify(item))
    this.changed(project)
    return item
  }
  addMetric(project: string, raw: unknown): Metric {
    const input = metricSchema.parse(raw)
    if (input.lower !== null && input.upper !== null && less(input.upper, input.lower)) throw new Error('正常范围下限不能大于上限。')
    if (this.db.prepare('SELECT id FROM metrics WHERE project_id=? AND code=?').get(project, input.code)) throw new Error('该指标代码已存在。')
    const item: Metric = { ...input, id: uid(), projectId: project }
    this.db.prepare('INSERT INTO metrics VALUES(?,?,?,?)').run(item.id, project, input.code, JSON.stringify(item))
    this.changed(project)
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
    this.changed(project)
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
      this.changed(project)
      return item
    })
  }
  history(project: string, id: string): Revision[] {
    this.item('records', project, id)
    return this.rows<Revision>('SELECT payload FROM revisions WHERE project_id=? AND record_id=? ORDER BY revision DESC', project, id)
  }
  /** Validate the whole plan in a savepoint, then discard every proposed write. */
  prepareManagement(project: string, run: string, raw: unknown) {
    const request = managementRequestSchema.parse(raw), expectedRevision = this.revision(project)
    this.db.exec('SAVEPOINT management_preview')
    try {
      const { changes } = this.applyManagement(project, run, request, 'preview')
      return { payload: { projectId: project, runId: run, expectedRevision, request }, changes,
        summary: `整理原因：${request.reason}\n共 ${changes.length} 项变更；批准后一起执行。\n\n${changes.map((change, i) => `${i + 1}. ${change.summary}`).join('\n\n')}\n\n已有测量值与单位保持原样，整理前的记录和修改原因可回查。` }
    } finally { this.db.exec('ROLLBACK TO management_preview; RELEASE management_preview') }
  }
  manage(project: string, run: string, raw: unknown, actor = 'agent-approved') {
    const plan = preparedManagementSchema.parse(raw)
    if (plan.projectId !== project || plan.runId !== run) throw new Error('整理提案不属于当前项目或运行，请重新发起。')
    return this.transaction(() => {
      if (plan.expectedRevision !== this.revision(project)) throw new Error('数据库在等待审批期间已发生变化，请拒绝旧提案并重新核对后提交。')
      const result = this.applyManagement(project, run, plan.request, actor)
      const entry: ManagementEntry = { id: uid(), projectId: project, runId: run, at: now(), actor, reason: plan.request.reason, changes: result.changes }
      this.db.prepare('INSERT INTO management_history VALUES(?,?,?)').run(entry.id, project, JSON.stringify(entry))
      return { message: `已完成 ${entry.changes.length} 项数据库整理，原始测量值和单位已保留。`, auditId: entry.id, ...result }
    })
  }
  managementHistory(project: string, limit = 10, offset = 0): ManagementEntry[] {
    return this.rows<ManagementEntry>('SELECT payload FROM management_history WHERE project_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?', project, Math.min(20, Math.max(1, limit)), Math.max(0, offset))
  }
  private applyManagement(project: string, run: string, request: ManagementRequest, actor: string) {
    const created: Record<string, string> = Object.create(null), changes: ManagementChange[] = []
    const resolve = (reference: string) => reference.startsWith('@') ? created[reference.slice(1)] ?? (() => { throw new Error(`未找到前序新建对象 ${reference}。`) })() : reference
    const describeId = (field: string, id: string) => {
      if (field === 'roundId') { const item = this.item<Round>('rounds', project, id); return `第 ${item.number} 轮 · ${item.name}` }
      if (field === 'batchId') { const item = this.item<Batch>('batches', project, id); return `${item.code} · ${item.name}` }
      return id
    }
    for (const operation of request.operations) {
      if ('ref' in operation && created[operation.ref]) throw new Error(`新建对象引用 ${operation.ref} 重复。`)
      if (operation.action === 'create_round' || operation.action === 'create_batch' || operation.action === 'create_metric') {
        const kind = operation.action === 'create_round' ? 'round' : operation.action === 'create_batch' ? 'batch' : 'metric'
        const item = operation.action === 'create_round' ? this.addRound(project, run, operation.data)
          : operation.action === 'create_batch' ? this.addBatch(project, run, { ...operation.data, roundId: resolve(operation.data.roundId) }) : this.addMetric(project, operation.data)
        created[operation.ref] = item.id
        const after = { ...item }, label = kind === 'round' ? '轮次' : kind === 'batch' ? '批次' : '指标'
        changes.push({ kind, id: item.id, before: null, after, summary: describeManagementChange(`新建${label}`, null, after, Object.keys(operation.data), describeId) })
      } else if (operation.action === 'update_round') {
        const before = this.item<Round>('rounds', project, resolve(operation.id))
        const { appendNote, ...patch } = operation.patch
        const fields: Partial<Pick<Round, 'number' | 'name' | 'note'>> = { ...patch }
        if (appendNote !== undefined) fields.note = appendManagementNote(before.note, appendNote)
        const after: Round = { ...before, ...roundSchema.parse({ number: before.number, name: before.name, note: before.note, ...fields }) }
        if (Object.keys(fields).every(key => before[key as keyof Round] === after[key as keyof Round])) continue
        if (this.db.prepare('SELECT id FROM rounds WHERE project_id=? AND number=? AND id<>?').get(project, after.number, before.id)) throw new Error('目标轮次编号已存在。')
        const summary = describeManagementChange(`整理轮次：第 ${before.number} 轮 · ${before.name}`, { ...before }, { ...after }, Object.keys(fields), describeId)
        this.db.prepare('UPDATE rounds SET number=?,payload=? WHERE project_id=? AND id=?').run(after.number, JSON.stringify(after), project, before.id)
        this.changed(project)
        changes.push({ kind: 'round', id: before.id, before: { ...before }, after: { ...after }, summary })
      } else if (operation.action === 'update_batch') {
        const before = this.item<Batch>('batches', project, resolve(operation.id)), fields = { ...operation.patch }
        if (fields.roundId) fields.roundId = resolve(fields.roundId)
        const after: Batch = { ...before, ...batchSchema.parse({ roundId: before.roundId, code: before.code, name: before.name, conditions: before.conditions, ...fields }) }
        if (Object.keys(fields).every(key => before[key as keyof Batch] === after[key as keyof Batch])) continue
        this.item('rounds', project, after.roundId)
        if (this.db.prepare('SELECT id FROM batches WHERE project_id=? AND round_id=? AND code=? AND id<>?').get(project, after.roundId, after.code, before.id)) throw new Error('目标轮次中已有相同批次编号，请先核对。')
        const count = this.records(project, { batchId: before.id, limit: 1 }).total
        const summary = describeManagementChange(`整理批次：${before.code} · ${before.name}（${count} 条测量记录）`, { ...before }, { ...after }, Object.keys(fields), describeId)
        this.db.prepare('UPDATE batches SET round_id=?,code=?,payload=? WHERE project_id=? AND id=?').run(after.roundId, after.code, JSON.stringify(after), project, before.id)
        this.changed(project)
        changes.push({ kind: 'batch', id: before.id, before: { ...before }, after: { ...after }, summary })
      } else if (operation.action === 'update_metric') {
        const before = this.item<Metric>('metrics', project, resolve(operation.id)), after = { ...before, ...operation.patch }
        if (Object.keys(operation.patch).every(key => before[key as keyof Metric] === after[key as keyof Metric])) continue
        if (this.db.prepare('SELECT id FROM metrics WHERE project_id=? AND code=? AND id<>?').get(project, after.code, before.id)) throw new Error('该指标代码已存在，不能直接合并指标。')
        this.db.prepare('UPDATE metrics SET code=?,payload=? WHERE project_id=? AND id=?').run(after.code, JSON.stringify(after), project, before.id)
        this.changed(project)
        changes.push({ kind: 'metric', id: before.id, before: { ...before }, after: { ...after }, summary: describeManagementChange(`整理指标：${before.code} · ${before.name}（单位 ${before.unit || '无量纲'}）`, { ...before }, { ...after }, Object.keys(operation.patch), describeId) })
      } else {
        const before = this.item<Observation>('records', project, resolve(operation.id))
        const { appendNote, ...patch } = operation.patch
        const fields: Partial<Pick<Observation, 'batchId' | 'sample' | 'note'>> = { ...patch }
        if (appendNote !== undefined) fields.note = appendManagementNote(before.note, appendNote)
        if (fields.batchId) fields.batchId = resolve(fields.batchId)
        const after: Observation = { ...before, ...fields, revision: before.revision + 1, updatedAt: now() }
        if (Object.keys(fields).every(key => before[key as keyof Observation] === after[key as keyof Observation])) continue
        this.item('batches', project, after.batchId)
        const existing = this.existing(project, after)
        if (existing && existing.id !== before.id) throw new Error('目标批次的采样点和指标已有记录，请核对后单独处理，不能覆盖。')
        const summary = describeManagementChange(`整理采样记录：${before.sample}（${before.value} ${before.unit}；来源 ${before.source} ${before.locator}）`, { ...before }, { ...after }, Object.keys(fields), describeId)
        this.db.prepare('UPDATE records SET batch_id=?,sample=?,revision=?,payload=? WHERE project_id=? AND id=?').run(after.batchId, after.sample, after.revision, JSON.stringify(after), project, before.id)
        this.saveRevision(after, actor, request.reason)
        this.changed(project)
        changes.push({ kind: 'record', id: before.id, before: { ...before }, after: { ...after }, summary })
      }
    }
    if (!changes.length) throw new Error('所选内容与数据库一致，无需提交整理审批。')
    return { created, changes }
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
  /** Keep identity beside each observation instead of requiring joins across model messages. */
  recordsWithContext(project: string, filter: Parameters<BatchDataStore['records']>[1] = {}) {
    const page = this.records(project, filter), catalogue = this.catalogue(project)
    const batches = new Map(catalogue.batches.map(item => [item.id, item]))
    const rounds = new Map(catalogue.rounds.map(item => [item.id, item]))
    const metrics = new Map(catalogue.metrics.map(item => [item.id, item]))
    return { ...page, items: page.items.map(record => {
      const batch = batches.get(record.batchId)!, round = rounds.get(batch.roundId)!
      return { ...record, round: { id: round.id, number: round.number, name: round.name },
        batch: { id: batch.id, code: batch.code, name: batch.name }, metric: metrics.get(record.metricId)! }
    }) }
  }
  /** Project-scoped, bounded matrix. Missing cells never borrow an adjacent batch's value. */
  overview(project: string, raw: unknown = {}) {
    const input = overviewSchema.parse(raw), catalogue = this.catalogue(project)
    if (input.roundId) this.item('rounds', project, input.roundId)
    if (input.metricId) this.item('metrics', project, input.metricId)
    const rounds = new Map(catalogue.rounds.map(item => [item.id, item]))
    const batches = catalogue.batches.filter(item => !input.roundId || item.roundId === input.roundId)
      .sort((a, b) => rounds.get(a.roundId)!.number - rounds.get(b.roundId)!.number || a.code.localeCompare(b.code) || a.id.localeCompare(b.id))
    const metrics = catalogue.metrics.filter(item => !input.metricId || item.id === input.metricId)
    const args: Array<string | number> = [project, project], where = ['r.project_id=?', 'b.project_id=?']
    if (input.roundId) { where.push('b.round_id=?'); args.push(input.roundId) }
    if (input.metricId) { where.push('r.metric_id=?'); args.push(input.metricId) }
    const sampleQuery = `FROM records r JOIN batches b ON b.id=r.batch_id WHERE ${where.join(' AND ')}`
    const sampleTotal = (this.db.prepare(`SELECT COUNT(DISTINCT r.sample) AS n ${sampleQuery}`).get(...args) as { n: number }).n
    const samples = (this.db.prepare(`SELECT DISTINCT r.sample ${sampleQuery} ORDER BY r.sample LIMIT ? OFFSET ?`)
      .all(...args, input.sampleLimit, input.sampleOffset) as { sample: string }[]).map(item => item.sample)
    const total = batches.length * metrics.length, rows: OverviewRow[] = []
    for (let i = input.offset; i < Math.min(total, input.offset + input.limit); i++) {
      const batch = batches[Math.floor(i / metrics.length)]!, metric = metrics[i % metrics.length]!, round = rounds.get(batch.roundId)!
      const records = samples.length ? this.rows<Observation>(`SELECT payload FROM records WHERE project_id=? AND batch_id=? AND metric_id=? AND sample IN (${samples.map(() => '?').join(',')})`, project, batch.id, metric.id, ...samples) : []
      const bySample = new Map(records.map(item => [item.sample, item]))
      rows.push({ round: { id: round.id, number: round.number, name: round.name },
        batch: { id: batch.id, code: batch.code, name: batch.name, conditions: batch.conditions }, metric,
        cells: samples.map(sample => {
          const record = bySample.get(sample) ?? null
          return { sample, status: record ? 'recorded' : 'missing', value: record?.value ?? null, record }
        }) })
    }
    return { projectId: project, rows, samples, total, offset: input.offset, limit: input.limit,
      sampleTotal, sampleOffset: input.sampleOffset, sampleLimit: input.sampleLimit,
      hasMoreRows: input.offset + rows.length < total, hasMoreSamples: input.sampleOffset + samples.length < sampleTotal,
      alignment: 'Exact batchId + metricId + sample. Different sample spellings are separate columns until an organization plan is approved. Missing means no matching record; it is not zero or proof that no sample was taken.',
      table: overviewTable(samples, rows) }
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
