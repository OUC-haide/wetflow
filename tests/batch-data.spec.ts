import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BatchDataStore, subtract } from '../src/batch-data/store.js'
import { createWetFlowContext } from '../src/cordis.js'
import { createWetFlowPlugins } from '../src/plugins/manager.js'
import { createServer } from '../src/server.js'

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-batches-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'data.db'), store = new BatchDataStore(path)
  let closed = false
  const close = () => { if (!closed) { store.close(); closed = true } }
  cleanup.push(close)
  const round = store.addRound('p1', 'r1', { number: 1, name: 'Round A' })
  const batch = store.addBatch('p1', 'r1', { roundId: round.id, code: 'B1', name: 'Baseline', conditions: 'original condition' })
  const metric = store.addMetric('p1', { code: 'TEMP', name: 'Temperature', unit: '°C', lower: '20', upper: '40' })
  const raw = { batchId: batch.id, metricId: metric.id, sample: 'T1', value: '30.000000000001', unit: '°C', source: 'actual.csv', locator: 'row 3' }
  return { dir, path, store, round, batch, metric, raw, close }
}
describe('batch database precision, provenance and project boundaries', () => {
  it('stores original decimals, reports deviations and rejects invalid units without partial changes', () => {
    const { store, raw } = fixture()
    const result = store.record('p1', 'r1', raw)
    expect(result.item.value).toBe('30.000000000001')
    expect(store.record('p1', 'r1', raw).duplicate).toBe(true)
    expect(() => store.record('p1', 'r1', { ...raw, value: '30', unit: 'K' })).toThrow('单位不匹配')
    expect(store.catalogue('p1').recordCount).toBe(1)
    const deviation = store.record('p1', 'r2', { ...raw, sample: 'T2', value: '99.00' }).item
    expect(deviation).toMatchObject({ value: '99.00', deviation: true, runId: 'r2' })
    expect(store.catalogue('p2').recordCount).toBe(0)
    expect(() => store.records('p2', { batchId: raw.batchId })).toThrow('不属于当前项目')
    expect(() => store.record('p2', 'r2', raw)).toThrow('不属于当前项目')
    expect(() => store.history('p2', result.item.id)).toThrow('不属于当前项目')
  })
  it('keeps all corrections with provenance and rejects a stale revision', () => {
    const { store, raw } = fixture()
    const original = store.record('p1', 'r1', raw).item
    const correction = { value: '30.500', unit: '°C', source: 'corrected.csv', locator: 'row 7', reason: 'Corrected transcription', expectedRevision: 1 }
    const corrected = store.correct('p1', original.id, correction)
    expect(corrected).toMatchObject({ value: '30.500', revision: 2 })
    expect(store.history('p1', original.id).map(h => h.data.value)).toEqual(['30.500', '30.000000000001'])
    expect(store.history('p1', original.id)[0]?.reason).toBe('Corrected transcription')
    expect(() => store.correct('p1', original.id, correction)).toThrow('刷新')
    expect(() => store.correct('p1', original.id, { ...correction, expectedRevision: 2, reason: '' })).toThrow()
    expect(store.history('p1', original.id)).toHaveLength(2)
  })
  it('previews all rows, atomically rejects invalid imports, skips exact duplicates and persists across reopening', () => {
    const { store, raw, path, close } = fixture()
    const header = 'sample,metric,value,unit,source,locator,sampledAt,note\n'
    const first = 'T1,TEMP,30.000000000001,°C,actual.csv,row 3,,\n'
    const bad = 'T2,TEMP,30,K,actual.csv,row 4,,\n'
    expect(store.preview('p1', raw.batchId, header + first + bad)).toMatchObject({ newCount: 1, errorCount: 1 })
    expect(() => store.import('p1', 'r1', raw.batchId, header + first + bad)).toThrow('未写入')
    expect(store.catalogue('p1').recordCount).toBe(0)
    expect(store.import('p1', 'r1', raw.batchId, header + first)).toEqual({ inserted: 1, skipped: 0 })
    expect(store.import('p1', 'r1', raw.batchId, header + first)).toEqual({ inserted: 0, skipped: 1 })
    expect(store.preview('p1', raw.batchId, header + first + first).errorCount).toBe(1)
    expect(store.export('p1', raw.batchId)).toContain('30.000000000001')
    close(); const reopened = new BatchDataStore(path); cleanup.push(() => reopened.close())
    expect(reopened.records('p1').items[0]).toMatchObject({ value: raw.value, source: raw.source, revision: 1 })
  })
  it('compares exact aligned samples and retains missing values without zero imputation', () => {
    const { store, raw, metric } = fixture()
    const round2 = store.addRound('p1', 'r2', { number: 2, name: 'Round B' })
    const batch2 = store.addBatch('p1', 'r2', { roundId: round2.id, code: 'B1', name: 'New condition', conditions: 'changed condition' })
    store.record('p1', 'r1', raw)
    store.record('p1', 'r2', { ...raw, batchId: batch2.id, value: '30.100000000002' })
    store.record('p1', 'r2', { ...raw, batchId: batch2.id, sample: 'T2' })
    const comparison = store.compare('p1', raw.batchId, batch2.id)
    expect(comparison).toMatchObject({ matched: 1, missing: 1, right: { conditions: 'changed condition' } })
    expect(comparison.items.find(x => x.sample === 'T1')).toMatchObject({ delta: '0.100000000001', metric: { id: metric.id } })
    expect(comparison.items.find(x => x.sample === 'T2')).toMatchObject({ delta: null, left: null })
    expect(subtract('100000000000000000000000.1', '99999999999999999999999.9')).toBe('0.2')
    expect(subtract('-0.01', '0.09')).toBe('-0.1')
    expect(subtract('1.00', '1.0')).toBe('0')
    expect(() => store.compare('p2', raw.batchId, batch2.id)).toThrow('不属于当前项目')
  })
})

async function pluginFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-extension-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = await createWetFlowContext({ dbPath: join(dir, 'core.db'), allowDocumentExcerpts: () => true })
  cleanup.push(() => ctx.fiber.dispose())
  const plugins = await createWetFlowPlugins(ctx, {
    experiment: { dbPath: join(dir, 'experiment.db') }, research: { dbPath: join(dir, 'research.db'), modeling: () => ctx.wetflowModeling! },
    modeling: { dataDir: join(dir, 'modeling'), createPrediction: () => ({ id: 'fixture' }) },
  })
  return { ctx, plugins, dir }
}
describe('optional plugin lifecycle and Agent integration', () => {
  it('mounts batch tools, requires approval, removes stale handles and restores saved data on reload', async () => {
    const { ctx, plugins } = await pluginFixture()
    expect(ctx.wetflow.tools.has('batch_data_query')).toBe(false)
    await plugins.load('batch-data')
    const db = ctx.wetflowBatchData!, p = ctx.wetflow.store.activeProjectId(), r = ctx.wetflow.store.activeWorkflowRunId()
    const round = db.addRound(p, r, { number: 1, name: 'test' })
    const batch = db.addBatch(p, r, { roundId: round.id, code: 'B1', name: 'batch' })
    const metric = db.addMetric(p, { code: 'OD', name: 'reading', unit: '' })
    ctx.wetflow.setProvider({ models: async () => [{ id: 'fixture', label: 'Fixture' }], defaultModel: () => 'fixture',
      complete: async () => ({ content: '请确认记录。', toolCall: { name: 'batch_data_record', arguments: { batchId: batch.id, metricId: metric.id, sample: 'T1', value: '0.1200', unit: '', source: 'operator.csv' } } }) })
    const turn = await ctx.wetflow.chat('将我的读数写入批次')
    expect(turn.turn?.status).toBe('approval_pending')
    expect(db.catalogue(p).recordCount).toBe(0)
    await ctx.wetflow.decide(turn.approvals[0]!.id, 'approve')
    expect(db.records(p).items[0]?.value).toBe('0.1200')
    const stale = ctx.wetflow.tools.get('batch_data_query')
    await plugins.unload('batch-data')
    expect(ctx.wetflow.tools.instructions()).not.toContain('多批次数据插件已启用')
    expect(() => stale.execute({})).toThrow('unloaded')
    await plugins.load('batch-data')
    expect(ctx.wetflowBatchData!.catalogue(p).recordCount).toBe(1)
  })
  it('makes attachment support and planner optional, with dependency cascade and persistent custom routes', async () => {
    const { ctx, plugins } = await pluginFixture()
    expect(ctx.wetflow.store.workflow().plan?.status).toBe('confirmed')
    expect(ctx.wetflow.tools.has('workflow_set_plan')).toBe(false)
    await plugins.load('workflow-planner')
    const pending = ctx.wetflow.newWorkflowRun('plan run').workflow
    expect(pending.plan?.status).toBe('pending')
    await plugins.unload('workflow-planner')
    expect(ctx.wetflow.store.workflow().plan?.status).toBe('pending')
    expect(ctx.wetflow.tools.has('workflow_set_plan')).toBe(false)
    expect(ctx.wetflow.newWorkflowRun('baseline run').workflow.plan?.status).toBe('confirmed')
    await plugins.load('document-media')
    expect(ctx.wetflowDocumentMedia).toBeUndefined()
    await plugins.load('local-files')
    expect(ctx.wetflowDocumentMedia).toBeDefined()
    expect(ctx.wetflow.tools.ownedBy('local-files')).toContain('local_file_read')
    expect(ctx.wetflow.tools.attachments).toBeDefined()
    await plugins.unload('document-media')
    expect(ctx.wetflow.tools.has('local_file_read')).toBe(true)
    expect(() => ctx.wetflow.tools.attachments!.validate([{ id: 'fixture', name: 'sample.pdf', path: '/unused/sample.pdf', kind: 'pdf' }])).toThrow('PDF 与多模态')
    expect(() => ctx.wetflow.tools.attachments!.validate([{ id: 'fixture', name: 'sample.txt', path: '/unused/sample.txt', kind: 'text' }])).not.toThrow()
    await plugins.load('document-media')
    await plugins.unload('local-files')
    expect(ctx.wetflowDocumentMedia).toBeUndefined()
    expect(ctx.wetflow.tools.attachments).toBeUndefined()
    expect(ctx.wetflow.tools.instructions()).not.toContain('PDF 与多模态插件已启用')
    await plugins.load('local-files')
    expect(ctx.wetflowDocumentMedia).toBeDefined()
  })
  it('guards HTTP writes against a switched project and remembers disabled plugins across server restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-batch-http-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const options = { dbPath: join(dir, 'core.db'), settingsPath: join(dir, 'settings.json'), industrialDbPath: join(dir, 'industrial.db'),
      industrialSettingsPath: join(dir, 'industrial.json'), modelingDataDir: join(dir, 'modeling'), serveWeb: false }
    const app = await createServer(options)
    try {
      const response = await app.inject({ method: 'POST', url: '/api/batch-data/rounds', headers: { 'x-wetflow-project': 'another-project' }, payload: { number: 1, name: 'wrong' } })
      expect(response.statusCode).toBe(409)
      expect((await app.inject('/api/batch-data/catalog')).json().rounds).toEqual([])
      expect((await app.inject({ method: 'POST', url: '/api/plugins/batch-data/unload' })).statusCode).toBe(200)
      expect((await app.inject('/api/batch-data/catalog')).statusCode).toBe(503)
    } finally { await app.close() }
    const restarted = await createServer(options)
    try { expect((await restarted.inject('/api/batch-data/catalog')).statusCode).toBe(503) } finally { await restarted.close() }
  })
})
