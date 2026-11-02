import { CSV_HEADERS } from './csv.js'
import type { ImportDocument, ImportMapping, ImportTable } from './import-types.js'
import type { Metric } from './types.js'

const aliases = {
  sample: ['sample', 'sampleid', '采样点', '样品', '样品编号', '时间', 'time', 'timeh', '时间h', '发酵时间h', '发酵时间'],
  metric: ['metric', '指标', '指标代码', '检测指标', '测量指标'],
  value: ['value', '数值', '测量值', '结果', '检测结果'],
  unit: ['unit', '单位'], note: ['note', '备注'], sampledAt: ['sampledat', '采样时间'],
}
const normalized = (text: string) => text.toLowerCase().replace(/[\s_()（）\[\]【】]/g, '')
export function guessImportMapping(table: ImportTable, metrics: Metric[], chosenHeader?: number): ImportMapping {
  const headerRow = chosenHeader ?? Math.max(0, table.rows.slice(0, 20).findIndex(row => row.cells.some(x => aliases.sample.includes(normalized(x)))))
  const headers = table.rows[headerRow]?.cells ?? []
  const column = (key: keyof typeof aliases) => headers.findIndex(x => aliases[key].includes(normalized(x)))
  const wideMetrics: Record<number, string> = {}
  headers.forEach((header, index) => {
    const found = metrics.find(metric => [metric.name, metric.code, `${metric.name}(${metric.unit})`, `${metric.code}(${metric.unit})`]
      .some(label => normalized(label) === normalized(header)))
    if (found) wideMetrics[index] = found.code
  })
  return { headerRow, startRow: headerRow + 1, endRow: table.rows.length - 1,
    sample: column('sample'), metric: column('metric'), value: column('value'), unit: column('unit'), note: column('note'), sampledAt: column('sampledAt'),
    mode: column('value') >= 0 ? 'long' : 'wide', fixedMetric: '', wideMetrics }
}

export function mappedImportCsv(document: ImportDocument, table: ImportTable, mapping: ImportMapping, metrics: Metric[]): string {
  const { startRow, endRow, sample } = mapping
  if (!Number.isInteger(startRow) || !Number.isInteger(endRow) || startRow < 0 || endRow >= table.rows.length || endRow < startRow) throw new Error('请选择有效的数据起止行。')
  if (sample < 0) throw new Error('请选择采样点对应的列。')
  if (mapping.mode === 'long' && (mapping.value < 0 || (mapping.metric < 0 && !mapping.fixedMetric))) throw new Error('请选择数值列，并指定指标列或固定指标。')
  const selected = Object.entries(mapping.wideMetrics).filter(([index, code]) => Number(index) !== sample && !!code)
  if (mapping.mode === 'wide' && !selected.length) throw new Error('请至少为一个数值列选择指标。')
  const rows: string[][] = [CSV_HEADERS]
  const header = table.rows[mapping.headerRow]?.cells
  for (let i = startRow; i <= endRow; i++) {
    const row = table.rows[i]!, cell = (index: number) => row.cells[index]?.trim() ?? ''
    if (!row.cells.some(x => x.trim())) continue
    if (header && row.cells.length === header.length && row.cells.every((x, j) => x.trim() === header[j]?.trim())) continue
    const pairs: Array<[number, string]> = mapping.mode === 'wide'
      ? selected.map(([index, code]) => [Number(index), code]) : [[mapping.value, mapping.metric >= 0 ? cell(mapping.metric) : mapping.fixedMetric]]
    for (const [valueColumn, codeOrName] of pairs) {
      const candidates = metrics.filter(x => x.code === codeOrName || x.name === codeOrName)
      const metric = metrics.find(x => x.code === codeOrName) ?? (candidates.length === 1 ? candidates[0] : undefined)
      if (!metric) throw new Error(`${row.locator}：指标「${codeOrName}」尚未定义或名称不唯一，请使用指标代码。`)
      const value = cell(valueColumn)
      // Missing values remain missing. Zero is a non-empty value and must be retained.
      if (mapping.mode === 'wide' && value === '') continue
      let unit = mapping.unit >= 0 && mapping.mode === 'long' ? cell(mapping.unit) : metric.unit
      if (mapping.mode === 'wide') {
        const label = header?.[valueColumn] ?? ''
        const headerUnit = /[（(\[]([^()（）\[\]]+)[）)\]]\s*$/.exec(label)?.[1]?.trim()
        if (headerUnit) unit = headerUnit
      }
      rows.push([cell(sample), metric.code, value, unit, document.name,
        `${row.locator}；第 ${valueColumn + 1} 列`, mapping.sampledAt >= 0 ? cell(mapping.sampledAt) : '', mapping.note >= 0 ? cell(mapping.note) : ''])
      if (rows.length > 2001) throw new Error('转换后超过 2000 条记录，请缩小数据行范围或减少本次导入的指标。')
    }
  }
  if (rows.length === 1) throw new Error('所选范围没有可导入的数据。')
  return rows.map(row => row.map(value => '"' + value.replaceAll('"', '""') + '"').join(',')).join('\r\n')
}
