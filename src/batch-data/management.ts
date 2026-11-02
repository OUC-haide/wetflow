import { z } from 'zod'
import { roundSchema, batchSchema, metricSchema } from './types.js'

const id = z.string().min(1).max(120)
const ref = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/)
const appendNote = z.string().trim().min(1).max(2000)
const patch = <T extends z.AnyZodObject>(schema: T) => schema.partial().strict().refine(value => Object.keys(value).length > 0, '至少提供一个需要修改的字段。')
export const managementOperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create_round'), ref, data: roundSchema }).strict(),
  z.object({ action: z.literal('create_batch'), ref, data: batchSchema }).strict(),
  z.object({ action: z.literal('create_metric'), ref, data: metricSchema }).strict(),
  z.object({ action: z.literal('update_round'), id, patch: patch(roundSchema.omit({ note: true }).extend({ appendNote })) }).strict(),
  z.object({ action: z.literal('update_batch'), id, patch: patch(batchSchema) }).strict(),
  z.object({ action: z.literal('update_metric'), id, patch: patch(metricSchema.pick({ code: true, name: true })) }).strict(),
  z.object({ action: z.literal('organize_record'), id, patch: patch(z.object({ batchId: id, sample: z.string().trim().min(1).max(120), appendNote })) }).strict(),
])
export const managementRequestSchema = z.object({ reason: z.string().trim().min(1).max(1000), operations: z.array(managementOperationSchema).min(1).max(30) }).strict()
export const preparedManagementSchema = z.object({ projectId: id, runId: id, expectedRevision: z.number().int().min(0), request: managementRequestSchema }).strict()
export type ManagementRequest = z.infer<typeof managementRequestSchema>
export interface ManagementChange {
  kind: 'round' | 'batch' | 'metric' | 'record'
  id: string
  before: Record<string, unknown> | null
  after: Record<string, unknown>
  summary: string
}
export interface ManagementEntry { id: string; projectId: string; runId: string; at: string; actor: string; reason: string; changes: ManagementChange[] }
const str = { type: 'string' }
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const roundFields = { number: { type: 'integer', minimum: 1 }, name: str, note: str }
const appendNoteField = { type: 'string', minLength: 1, maxLength: 2000, description: 'Optional new information to append. The service preserves the original note verbatim. Do not repeat or replace the original note; use the plan reason for the organization rationale.' }
const batchFields = { roundId: { type: 'string', description: 'An existing round ID, or @ref for a round created earlier in this plan.' }, code: str, name: str, conditions: str }
const metricFields = { code: str, name: str, unit: str, lower: { type: ['string', 'null'] }, upper: { type: ['string', 'null'] } }
export const managementToolProperties = {
  reason: { type: 'string', description: 'Explain why these changes are needed and the source/user instruction supporting them.' },
  operations: { type: 'array', minItems: 1, maxItems: 30, items: { anyOf: [
    object({ action: { const: 'create_round' }, ref: str, data: object(roundFields, ['number', 'name']) }, ['action', 'ref', 'data']),
    object({ action: { const: 'create_batch' }, ref: str, data: object(batchFields, ['roundId', 'code', 'name']) }, ['action', 'ref', 'data']),
    object({ action: { const: 'create_metric' }, ref: str, data: object(metricFields, ['code', 'name', 'unit']) }, ['action', 'ref', 'data']),
    object({ action: { const: 'update_round' }, id: str, patch: object({ number: roundFields.number, name: str, appendNote: appendNoteField }) }, ['action', 'id', 'patch']),
    object({ action: { const: 'update_batch' }, id: str, patch: object(batchFields) }, ['action', 'id', 'patch']),
    object({ action: { const: 'update_metric' }, id: str, patch: object({ code: str, name: str }) }, ['action', 'id', 'patch']),
    object({ action: { const: 'organize_record' }, id: str, patch: object({ batchId: str, sample: str, appendNote: appendNoteField }) }, ['action', 'id', 'patch']),
  ] } },
}
export function appendManagementNote(original: string, addition: string): string {
  const result = original ? `${original}\n${addition}` : addition
  if (result.length > 2000) throw new Error('追加后备注超过 2000 字符，请缩短新增说明；原备注不能截断或覆盖。')
  return result
}
const labels: Record<string, string> = { number: '轮次编号', name: '名称', note: '备注', roundId: '所属轮次', batchId: '所属批次', code: '代码', conditions: '实验条件', sample: '采样点', unit: '单位', lower: '正常下限', upper: '正常上限' }
export function describeManagementChange(title: string, before: Record<string, unknown> | null, after: Record<string, unknown>, fields: string[], describeId: (field: string, id: string) => string): string {
  const display = (field: string, value: unknown) => value == null || value === '' ? '未填写' : /Id$/.test(field) ? describeId(field, String(value)) : String(value)
  return title + '\n' + fields.filter(field => !before || before[field] !== after[field]).map(field => `${labels[field] ?? field}：${before ? display(field, before[field]) + ' → ' : ''}${display(field, after[field])}`).join('\n')
}
