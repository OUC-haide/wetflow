import { z } from 'zod'

const label = z.string().trim().min(1).max(120)
const note = z.string().trim().max(2000).default('')
export const decimal = z.string().regex(/^-?\d{1,24}(?:\.\d{1,12})?$/, '使用十进制文本填写数值，最多 24 位整数和 12 位小数，不使用科学计数法。')
export const roundSchema = z.object({ name: label, number: z.number().int().min(1).max(1000000), note }).strict()
export const batchSchema = z.object({ roundId: label, code: label, name: label, conditions: note }).strict()
export const metricSchema = z.object({ code: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/), name: label,
  unit: z.string().trim().max(40), lower: decimal.nullable().default(null), upper: decimal.nullable().default(null) }).strict()
export const recordSchema = z.object({ batchId: label, metricId: label, sample: label, value: decimal,
  unit: z.string().trim().max(40), source: z.string().trim().min(1).max(600), locator: z.string().trim().max(300).default(''), note,
  sampledAt: z.string().datetime({ offset: true }).nullable().default(null) }).strict()
export const correctionSchema = recordSchema.omit({ batchId: true, metricId: true, sample: true }).extend({
  expectedRevision: z.number().int().min(1), reason: z.string().trim().min(1).max(1000),
}).strict()
export type Round = z.output<typeof roundSchema> & { id: string; projectId: string; runId: string; createdAt: string }
export type Batch = z.output<typeof batchSchema> & { id: string; projectId: string; runId: string; createdAt: string }
export type Metric = z.output<typeof metricSchema> & { id: string; projectId: string }
export type Observation = z.output<typeof recordSchema> & { id: string; projectId: string; runId: string;
  revision: number; deviation: boolean; createdAt: string; updatedAt: string }
export interface Revision { recordId: string; revision: number; actor: string; reason: string; at: string; data: Observation }
export interface Catalogue { rounds: Round[]; batches: Batch[]; metrics: Metric[]; recordCount: number }
export interface RecordPage { items: Observation[]; total: number; offset: number; limit: number }
export interface ImportPreview { rows: Array<{ line: number; status: 'new' | 'duplicate' | 'error'; message: string; deviation?: boolean }>;
  newCount: number; duplicateCount: number; errorCount: number }
export interface Comparison { left: Batch; right: Batch; items: Array<{ metric: Metric; sample: string;
  left: Observation | null; right: Observation | null; delta: string | null; status: 'matched' | 'missing' }>; matched: number; missing: number }
