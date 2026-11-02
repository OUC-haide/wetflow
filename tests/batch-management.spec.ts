import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BatchDataStore } from '../src/batch-data/store.js'
import { createWetFlowContext } from '../src/cordis.js'
import { createWetFlowPlugins } from '../src/plugins/manager.js'
import { createServer } from '../src/server.js'

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function fixture(store = new BatchDataStore(':memory:'), project = 'p', run = 'r') {
  const round = store.addRound(project, run, { number: 1, name: '杂项', note: '原备注' })
  const batch = store.addBatch(project, run, { roundId: round.id, code: 'B1', name: '未命名', conditions: '30 °C' })
  const metric = store.addMetric(project, { code: 'PMA', name: '浓度', unit: 'g/L' })
  const raw = { batchId: batch.id, metricId: metric.id, sample: '24小时', value: '10.500000000001', unit: 'g/L', source: 'original.xlsx', locator: 'Sheet1!B2', note: '合成数据，仅用于软件测试' }
  const record = store.record(project, run, raw).item
  const plan = { reason: '按实验记录统一目录和采样点命名', operations: [
    { action: 'create_round', ref: 'target', data: { number: 2, name: '第二轮发酵' } },
    { action: 'create_batch', ref: 'newbatch', data: { roundId: '@target', code: 'B2', name: '对照批次', conditions: '来源待补充' } },
    { action: 'update_batch', id: batch.id, patch: { roundId: '@target', name: '实验批次' } },
    { action: 'update_metric', id: metric.id, patch: { name: 'PMA 浓度' } },
    { action: 'organize_record', id: record.id, patch: { sample: '24 h' } },
  ] }
  return { store, project, run, round, batch, metric, raw, record, plan }
}
describe('reviewable database management', () => {
  it('previews a whole linked plan without writes, applies it atomically and preserves observations and audit history', () => {
    const f = fixture(); cleanup.push(() => f.store.close())
    const before = f.store.catalogue(f.project)
    const prepared = f.store.prepareManagement(f.project, f.run, f.plan)
    expect(prepared.changes).toHaveLength(5)
    expect(prepared.summary).toContain('24小时 → 24 h')
    expect(prepared.summary).toContain('第 1 轮 · 杂项 → 第 2 轮 · 第二轮发酵')
    expect(f.store.catalogue(f.project)).toEqual(before)
    expect(f.store.history(f.project, f.record.id)).toHaveLength(1)
    expect(f.store.managementHistory(f.project)).toEqual([])
    const result = f.store.manage(f.project, f.run, prepared.payload)
    expect(result.created.target).toBeTruthy()
    expect(f.store.catalogue(f.project).batches.find(x => x.id === f.batch.id)).toMatchObject({ roundId: result.created.target, name: '实验批次', conditions: '30 °C' })
    expect(f.store.records(f.project).items[0]).toMatchObject({ sample: '24 h', value: f.raw.value, unit: f.raw.unit, source: f.raw.source, locator: f.raw.locator, runId: f.run, revision: 2 })
    expect(f.store.history(f.project, f.record.id).map(x => x.data.sample)).toEqual(['24 h', '24小时'])
    expect(f.store.managementHistory(f.project)[0]).toMatchObject({ actor: 'agent-approved', reason: f.plan.reason, id: result.auditId })
    expect(f.store.managementHistory('other')).toEqual([])
    expect(() => f.store.manage(f.project, f.run, prepared.payload)).toThrow('已发生变化')
  })
  it('rejects a stale plan after normal imports and leaves previous changes untouched', () => {
    const f = fixture(); cleanup.push(() => f.store.close())
    const plan = f.store.prepareManagement(f.project, f.run, f.plan)
    f.store.import(f.project, f.run, f.batch.id, 'sample,metric,value,unit,source\n48 h,PMA,12.20,g/L,new.csv')
    expect(() => f.store.manage(f.project, f.run, plan.payload)).toThrow('等待审批期间')
    expect(f.store.catalogue(f.project).rounds).toHaveLength(1)
    expect(f.store.records(f.project).total).toBe(2)
    expect(f.store.managementHistory(f.project)).toEqual([])
  })
  it('rolls back earlier steps when a later step conflicts and refuses cross-project operations', () => {
    const f = fixture(); cleanup.push(() => f.store.close())
    const bad = { ...f.plan, operations: [...f.plan.operations, { action: 'create_round', ref: 'duplicate', data: { number: 1, name: 'conflict' } }] }
    expect(() => f.store.prepareManagement(f.project, f.run, bad)).toThrow('已存在')
    expect(f.store.catalogue(f.project).rounds).toHaveLength(1)
    expect(f.store.history(f.project, f.record.id)).toHaveLength(1)
    const other = f.store.addRound('another', f.run, { number: 3, name: 'foreign' })
    expect(() => f.store.prepareManagement(f.project, f.run, { reason: 'wrong', operations: [{ action: 'update_batch', id: f.batch.id, patch: { roundId: other.id } }] })).toThrow('不属于当前项目')
    const valid = f.store.prepareManagement(f.project, f.run, f.plan)
    expect(() => f.store.manage('another', f.run, valid.payload)).toThrow('不属于当前项目')
    expect(() => f.store.manage(f.project, 'another-run', valid.payload)).toThrow('不属于当前项目')
  })
  it('forbids deletion, changing readings or units through organization and rejects sample collisions', () => {
    const f = fixture(); cleanup.push(() => f.store.close())
    for (const operation of [
      { action: 'delete_record', id: f.record.id },
      { action: 'organize_record', id: f.record.id, patch: { value: '999' } },
      { action: 'update_metric', id: f.metric.id, patch: { unit: 'mg/L' } },
    ]) expect(() => f.store.prepareManagement(f.project, f.run, { reason: 'not organization', operations: [operation] })).toThrow()
    f.store.record(f.project, f.run, { ...f.raw, sample: '24 h', value: '99.0' })
    expect(() => f.store.prepareManagement(f.project, f.run, f.plan)).toThrow('已有记录')
    expect(f.store.records(f.project).items.map(x => x.value).sort()).toEqual(['10.500000000001', '99.0'])
    expect(f.store.catalogue(f.project).rounds).toHaveLength(1)
  })
  it('retains old batch membership and sources when moving a record into a newly created batch', () => {
    const f = fixture(); cleanup.push(() => f.store.close())
    const prepared = f.store.prepareManagement(f.project, f.run, { reason: '用户核对来源后重新归类', operations: [
      { action: 'create_batch', ref: 'target', data: { roundId: f.round.id, code: 'B2', name: '正确批次' } },
      { action: 'organize_record', id: f.record.id, patch: { batchId: '@target', appendNote: '重新核对批次' } },
    ] })
    const result = f.store.manage(f.project, f.run, prepared.payload)
    expect(f.store.records(f.project, { batchId: f.batch.id }).total).toBe(0)
    expect(f.store.records(f.project, { batchId: result.created.target! }).items[0]).toMatchObject({ source: 'original.xlsx', value: f.raw.value })
    expect(f.store.history(f.project, f.record.id)[1]?.data.batchId).toBe(f.batch.id)
  })
  it('rejects note replacement in organization previews and approvals, and appends without losing original notes', () => {
    const f = fixture(); cleanup.push(() => f.store.close())
    const request = { reason: '统一采样点，并追加已核实的说明', operations: [
      { action: 'update_round', id: f.round.id, patch: { appendNote: '轮次说明补充' } },
      { action: 'organize_record', id: f.record.id, patch: { sample: '24 h', appendNote: '采样点写法已核对' } },
    ] }
    const plan = f.store.prepareManagement(f.project, f.run, request)
    for (const operation of [
      { action: 'organize_record', id: f.record.id, patch: { sample: '24 h', note: '覆盖原备注' } },
      { action: 'update_round', id: f.round.id, patch: { note: '' } },
    ]) {
      const bad = { reason: request.reason, operations: [operation] }
      expect(() => f.store.prepareManagement(f.project, f.run, bad)).toThrow()
      // A persisted pre-fix proposal must not bypass the new write contract.
      expect(() => f.store.manage(f.project, f.run, { ...plan.payload, request: bad })).toThrow()
    }
    expect(f.store.records(f.project).items[0]?.note).toBe(f.raw.note)
    expect(f.store.catalogue(f.project).rounds[0]?.note).toBe('原备注')
    expect(plan.summary).toContain(f.raw.note + '\n采样点写法已核对')
    f.store.manage(f.project, f.run, plan.payload)
    expect(f.store.records(f.project).items[0]).toMatchObject({ sample: '24 h', note: f.raw.note + '\n采样点写法已核对', value: f.raw.value, source: f.raw.source })
    expect(f.store.history(f.project, f.record.id)[1]?.data.note).toBe(f.raw.note)
    expect(f.store.catalogue(f.project).rounds[0]?.note).toBe('原备注\n轮次说明补充')
  })
  it('rolls back the entire preview if appended notes exceed the storage limit, without truncation', () => {
    const f = fixture(); cleanup.push(() => f.store.close())
    expect(() => f.store.prepareManagement(f.project, f.run, { reason: '测试长备注', operations: [
      { action: 'update_round', id: f.round.id, patch: { name: '临时名称' } },
      { action: 'organize_record', id: f.record.id, patch: { appendNote: 'x'.repeat(2000) } },
    ] })).toThrow('原备注不能截断或覆盖')
    expect(f.store.catalogue(f.project).rounds[0]?.name).toBe(f.round.name)
    expect(f.store.records(f.project).items[0]?.note).toBe(f.raw.note)
    expect(f.store.history(f.project, f.record.id)).toHaveLength(1)
    expect(f.store.managementHistory(f.project)).toEqual([])
  })
  it('rejects unchanged plans without creating a misleading approval', () => {
    const f = fixture(); cleanup.push(() => f.store.close())
    expect(() => f.store.prepareManagement(f.project, f.run, { reason: 'unchanged', operations: [{ action: 'update_batch', id: f.batch.id, patch: { name: f.batch.name } }] })).toThrow('无需提交')
  })
})

it('stops the Agent at an approval, honors rejection, applies approval once and survives plugin reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-manage-agent-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = await createWetFlowContext({ dbPath: join(dir, 'core.db') }); cleanup.push(() => ctx.fiber.dispose())
  const plugins = await createWetFlowPlugins(ctx, {
    experiment: { dbPath: join(dir, 'experiment.db') }, research: { dbPath: join(dir, 'research.db'), modeling: () => ctx.wetflowModeling! },
    modeling: { dataDir: join(dir, 'modeling'), createPrediction: () => ({ id: 'fixture' }) }, 'batch-data': { dbPath: join(dir, 'batches.db') },
  })
  await plugins.load('batch-data')
  const f = fixture(ctx.wetflowBatchData!, ctx.wetflow.store.activeProjectId(), ctx.wetflow.store.activeWorkflowRunId())
  ctx.wetflow.setProvider({ models: async () => [{ id: 'fixture', label: 'Fixture' }], defaultModel: () => 'fixture',
    complete: async () => ({ content: '请核对整理方案。', toolCall: { name: 'batch_data_manage', arguments: f.plan } }) })
  const pending = await ctx.wetflow.chat('请整理数据库，提交给我审批')
  expect(pending.turn?.status).toBe('approval_pending')
  expect(pending.approvals[0]?.summary).toContain('24小时 → 24 h')
  expect(f.store.catalogue(f.project).rounds).toHaveLength(1)
  await ctx.wetflow.decide(pending.approvals[0]!.id, 'reject')
  expect(f.store.managementHistory(f.project)).toEqual([])
  const retry = await ctx.wetflow.chat('重新提交同一份整理方案')
  const approval = retry.approvals.find(x => x.status === 'PENDING')!
  await ctx.wetflow.decide(approval.id, 'approve')
  expect(f.store.records(f.project).items[0]?.sample).toBe('24 h')
  expect(f.store.managementHistory(f.project)).toHaveLength(1)
  const stale = ctx.wetflow.tools.get('batch_data_manage')
  await plugins.unload('batch-data')
  expect(ctx.wetflow.tools.instructions()).not.toContain('batch_data_manage')
  expect(() => stale.execute({})).toThrow('unloaded')
  await plugins.load('batch-data')
  expect(ctx.wetflowBatchData!.managementHistory(f.project)).toHaveLength(1)
})

it('keeps a stale Agent approval pending after another database write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-manage-stale-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = await createWetFlowContext({ dbPath: join(dir, 'core.db') }); cleanup.push(() => ctx.fiber.dispose())
  const plugins = await createWetFlowPlugins(ctx, {
    experiment: { dbPath: join(dir, 'experiment.db') }, research: { dbPath: join(dir, 'research.db'), modeling: () => ctx.wetflowModeling! },
    modeling: { dataDir: join(dir, 'modeling'), createPrediction: () => ({ id: 'fixture' }) }, 'batch-data': { dbPath: join(dir, 'batches.db') },
  })
  await plugins.load('batch-data')
  const f = fixture(ctx.wetflowBatchData!, ctx.wetflow.store.activeProjectId(), ctx.wetflow.store.activeWorkflowRunId())
  ctx.wetflow.setProvider({ models: async () => [{ id: 'fixture', label: 'Fixture' }], defaultModel: () => 'fixture', complete: async () => ({ content: '', toolCall: { name: 'batch_data_manage', arguments: f.plan } }) })
  const pending = await ctx.wetflow.chat('整理'), approval = pending.approvals.find(x => x.status === 'PENDING')!
  f.store.record(f.project, f.run, { ...f.raw, sample: '48 h' })
  await expect(ctx.wetflow.decide(approval.id, 'approve')).rejects.toThrow('已发生变化')
  expect(ctx.wetflow.snapshot().approvals.find(x => x.id === approval.id)?.status).toBe('PENDING')
  expect(f.store.catalogue(f.project).rounds).toHaveLength(1)
  expect(f.store.managementHistory(f.project)).toEqual([])
})

it('exposes read-only organization history only while the plugin is enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-manage-http-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const app = await createServer({ dbPath: join(dir, 'core.db'), settingsPath: join(dir, 'model.json'), industrialDbPath: join(dir, 'industrial.db'), industrialSettingsPath: join(dir, 'industrial.json'), modelingDataDir: join(dir, 'modeling'), serveWeb: false })
  cleanup.push(() => app.close())
  expect((await app.inject('/api/batch-data/management-history')).json()).toEqual([])
  expect((await app.inject({ method: 'POST', url: '/api/batch-data/management-history', payload: {} })).statusCode).toBe(404)
  await app.inject({ method: 'POST', url: '/api/plugins/batch-data/unload' })
  expect((await app.inject('/api/batch-data/management-history')).statusCode).toBe(503)
})
