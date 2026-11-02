import { overviewTable, comparisonTable } from './overview.js'
import type { BatchDataStore } from './store.js'
import type { Comparison, Observation } from './types.js'

// Stay below the Agent's 6,000-character observation cap. Trim whole rows,
// never JSON text, so missing cells and pagination metadata remain readable.
const MAX_VIEW_CHARS = 5700
const fits = (value: unknown) => JSON.stringify(value).length <= MAX_VIEW_CHARS

export function observationPage<T extends { items: unknown[]; total: number; offset: number; limit: number }>(page: T) {
  const items = [...page.items]
  const result = () => ({ ...page, items, limit: items.length, hasMore: page.offset + items.length < page.total,
    nextOffset: page.offset + items.length < page.total ? page.offset + items.length : null })
  while (items.length > 1 && !fits(result())) items.pop()
  if (!fits(result())) throw new Error('单条记录或批次条件过长，请缩小查询范围，按单个批次、指标和采样点读取。未返回截断数据。')
  return result()
}

export function overviewObservation(view: ReturnType<BatchDataStore['overview']>) {
  let rows = [...view.rows], samples = [...view.samples]
  const result = () => ({ projectId: view.projectId, table: overviewTable(samples, rows),
    total: view.total, offset: view.offset, limit: rows.length,
    nextOffset: view.offset + rows.length < view.total ? view.offset + rows.length : null,
    hasMoreRows: view.offset + rows.length < view.total,
    sampleTotal: view.sampleTotal, sampleOffset: view.sampleOffset, sampleLimit: samples.length,
    nextSampleOffset: view.sampleOffset + samples.length < view.sampleTotal ? view.sampleOffset + samples.length : null,
    hasMoreSamples: view.sampleOffset + samples.length < view.sampleTotal,
    samples, alignment: view.alignment,
    rows: rows.map(row => ({ ...row, cells: row.cells.map(cell => ({ sample: cell.sample, status: cell.status, value: cell.value,
      record: cell.record ? { id: cell.record.id, source: cell.record.source, locator: cell.record.locator,
        revision: cell.record.revision, deviation: cell.record.deviation } : null })) })) })
  while (rows.length > 1 && !fits(result())) rows.pop()
  while (samples.length > 1 && !fits(result())) {
    samples.pop()
    rows = rows.map(row => ({ ...row, cells: row.cells.slice(0, samples.length) }))
  }
  if (!fits(result())) throw new Error('单条汇总记录字段过长，请使用 batch_data_query 按批次、指标和采样点读取。未返回截断表格。')
  return result()
}

export function comparisonObservation(page: Comparison & { total: number; offset: number; limit: number }) {
  const items = [...page.items]
  const compact = (record: Observation | null) => record ? { id: record.id, value: record.value, unit: record.unit,
    source: record.source, locator: record.locator, revision: record.revision, deviation: record.deviation } : null
  const result = () => ({ ...page, table: comparisonTable(page.left, page.right, items),
    items: items.map(item => ({ ...item, left: compact(item.left), right: compact(item.right) })),
    limit: items.length, hasMore: page.offset + items.length < page.total,
    nextOffset: page.offset + items.length < page.total ? page.offset + items.length : null })
  while (items.length > 1 && !fits(result())) items.pop()
  if (!fits(result())) throw new Error('对比字段过长，请用 batch_data_query 按单个批次、指标和采样点读取。未返回截断对比。')
  return result()
}
