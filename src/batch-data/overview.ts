import { z } from 'zod'
import type { Batch, Comparison, Metric, Observation, Round } from './types.js'

export const overviewSchema = z.object({
  roundId: z.string().min(1).optional(), metricId: z.string().min(1).optional(),
  offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(30).default(20),
  sampleOffset: z.number().int().min(0).default(0), sampleLimit: z.number().int().min(1).max(12).default(12),
}).strict()
export interface OverviewRow {
  round: Pick<Round, 'id' | 'number' | 'name'>
  batch: Pick<Batch, 'id' | 'code' | 'name' | 'conditions'>
  metric: Metric
  cells: Array<{ sample: string; status: 'recorded' | 'missing'; value: string | null; record: Observation | null }>
}

/** Render the same keyed cells returned by the database, including explicit gaps. */
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ')
const line = (cells: string[]) => `| ${cells.map(escape).join(' | ')} |`
export function overviewTable(samples: string[], rows: OverviewRow[]): string {
  return [line(['轮次', '批次', '指标', '单位', ...samples]), line(Array(4 + samples.length).fill('---')),
    ...rows.map(row => line([`${row.round.number} · ${row.round.name}`, `${row.batch.code} · ${row.batch.name}`, `${row.metric.code} · ${row.metric.name}`,
      row.metric.unit || '无量纲', ...row.cells.map(cell => cell.value === null ? '未记录' : cell.value + (cell.record?.deviation ? '（偏差）' : ''))]))].join('\n')
}
export function comparisonTable(left: Batch, right: Batch, items: Comparison['items']): string {
  return [line(['指标', '单位', '采样点', `${left.code} · ${left.name}（左）`, `${right.code} · ${right.name}（右）`, '差值（右−左）']),
    line(Array(6).fill('---')), ...items.map(item => line([`${item.metric.code} · ${item.metric.name}`, item.metric.unit || '无量纲', item.sample,
      item.left?.value ?? '未记录', item.right?.value ?? '未记录', item.delta ?? '不可计算（缺记录）']))].join('\n')
}
