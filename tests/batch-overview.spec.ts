import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { BatchDataStore } from '../src/batch-data/store.js'
import { createWetFlowContext } from '../src/cordis.js'
import { createWetFlowPlugins } from '../src/plugins/manager.js'
import { observationPage, overviewObservation, comparisonObservation } from '../src/batch-data/agent-view.js'

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function fixture(store = new BatchDataStore(':memory:'), project = 'p', run = 'r') {
  const rounds = [2, 3].map(number => store.addRound(project, run, { number, name: `第${number}轮` }))
  const batches = rounds.map(round => store.addBatch(project, run, { roundId: round.id, code: 'B2', name: '同名批次', conditions: `轮次${round.number}条件` }))
  const metric = store.addMetric(project, { code: 'PMA', name: 'PMA 浓度', unit: 'g/L' })
  const add = (index: number, sample: string, value: string) => store.record(project, run, { batchId: batches[index]!.id, metricId: metric.id,
    sample, value, unit: metric.unit, source: 'synthetic.xlsx', locator: `R${rounds[index]!.number}-B2!B2`, note: '合成测试' }).item
  add(0, '24小时', '5.900'); add(0, '72 h', '15.000')
  add(1, '24 h', '6.100'); add(1, '48 h', '12.800'); add(1, '72 h', '15.900')
  return { store, project, run, rounds, batches, metric, add }
}

it('keeps a missing cell empty when a same-named batch in another round has a value, with exact identities and sources', () => {
  const f = fixture(); cleanup.push(() => f.store.close())
  f.add(0, '0 h', '0.000000000000')
  const before = f.store.records(f.project)
  const view = f.store.overview(f.project)
  expect(view).toMatchObject({ total: 2, hasMoreRows: false, hasMoreSamples: false })
  const [r2, r3] = view.rows
  expect(r2).toMatchObject({ round: { number: 2 }, batch: { id: f.batches[0]!.id, conditions: '轮次2条件' }, metric: { id: f.metric.id } })
  expect(r2!.cells.find(cell => cell.sample === '48 h')).toEqual({ sample: '48 h', status: 'missing', value: null, record: null })
  expect(r3!.cells.find(cell => cell.sample === '48 h')).toMatchObject({ status: 'recorded', value: '12.800', record: { batchId: f.batches[1]!.id, source: 'synthetic.xlsx', locator: 'R3-B2!B2' } })
  expect(r2!.cells.find(cell => cell.sample === '0 h')).toMatchObject({ status: 'recorded', value: '0.000000000000' })
  expect(r2!.cells.find(cell => cell.sample === '24 h')?.value).toBeNull()
  expect(r2!.cells.find(cell => cell.sample === '24小时')?.value).toBe('5.900')
  const line = view.table.split('\n').find(row => row.includes('2 · 第2轮'))!
  expect(line).toContain('未记录'); expect(line).not.toContain('12.800')
  const query = f.store.recordsWithContext(f.project, { batchId: f.batches[1]!.id, sample: '48 h' })
  expect(query.items[0]).toMatchObject({ value: '12.800', round: { number: 3 }, batch: { id: f.batches[1]!.id }, metric: { code: 'PMA' } })
  expect(f.store.records(f.project)).toEqual(before)
})

it('paginates rows and sample columns explicitly and scopes filters to the current project', () => {
  const f = fixture(); cleanup.push(() => f.store.close())
  for (let i = 0; i < 16; i++) f.add(0, `T${i}`, `${i}.000`)
  const foreign = fixture(f.store, 'foreign', 'foreign-run')
  foreign.add(0, 'SECRET_SAMPLE', '987.650')
  const page = f.store.overview(f.project, { limit: 1, sampleLimit: 2 })
  expect(page).toMatchObject({ total: 2, sampleTotal: 20, hasMoreRows: true, hasMoreSamples: true })
  expect(page.rows).toHaveLength(1); expect(page.rows[0]!.cells).toHaveLength(2)
  const next = f.store.overview(f.project, { offset: 1, limit: 1, sampleOffset: 2, sampleLimit: 2 })
  expect(next).toMatchObject({ hasMoreRows: false, hasMoreSamples: true })
  expect(next.rows[0]!.round.number).toBe(3)
  expect(next.samples.some(sample => page.samples.includes(sample))).toBe(false)
  const filtered = f.store.overview(f.project, { roundId: f.rounds[1]!.id, metricId: f.metric.id })
  expect(filtered.total).toBe(1); expect(filtered.sampleTotal).toBe(3)
  expect(JSON.stringify(filtered)).not.toContain('987.650')
  expect(() => f.store.overview(f.project, { roundId: foreign.rounds[0]!.id })).toThrow('不属于当前项目')
  expect(() => f.store.overview(f.project, { metricId: foreign.metric.id })).toThrow('不属于当前项目')
  expect(() => f.store.overview(f.project, { sampleLimit: 13 })).toThrow()
  expect(() => f.store.overview(f.project, { offset: -1 })).toThrow()
  expect(f.store.overview('empty')).toMatchObject({ rows: [], total: 0, samples: [], hasMoreRows: false, hasMoreSamples: false })
})

it('renders paired comparison values and exact differences without borrowing a neighboring observation', () => {
  const f = fixture(); cleanup.push(() => f.store.close())
  const metric = f.store.addMetric(f.project, { code: 'GLU', name: '残糖', unit: 'g/L' })
  for (const [index, value] of ['25.00', '20.00'].entries()) f.store.record(f.project, f.run, {
    batchId: f.batches[index]!.id, metricId: metric.id, sample: '48 h', value, unit: 'g/L', source: 'test.xlsx', locator: `R${index + 2}!C3` })
  const comparison = f.store.compare(f.project, f.batches[0]!.id, f.batches[1]!.id)
  const page = comparisonObservation({ ...comparison, total: comparison.items.length, offset: 0, limit: 30 })
  expect(JSON.stringify(page).length).toBeLessThan(6000)
  expect(page.table).toContain('| GLU · 残糖 | g/L | 48 h | 25.00 | 20.00 | -5 |')
  expect(page.table).toContain('| PMA · PMA 浓度 | g/L | 48 h | 未记录 | 12.800 | 不可计算（缺记录） |')
  expect(page.items.find(item => item.sample === '48 h' && item.metric.code === 'GLU')).toMatchObject({ delta: '-5', left: { value: '25.00' }, right: { value: '20.00' } })
})

it('exposes the overview through the plugin and removes it when unloaded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-overview-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = await createWetFlowContext({ dbPath: join(dir, 'core.db') }); cleanup.push(() => ctx.fiber.dispose())
  const plugins = await createWetFlowPlugins(ctx, { experiment: { dbPath: join(dir, 'experiment.db') },
    research: { dbPath: join(dir, 'research.db'), modeling: () => ctx.wetflowModeling! },
    modeling: { dataDir: join(dir, 'modeling'), createPrediction: () => ({ id: 'fixture' }) }, 'batch-data': { dbPath: join(dir, 'batches.db') } })
  await plugins.load('batch-data')
  const f = fixture(ctx.wetflowBatchData!, ctx.wetflow.store.activeProjectId(), ctx.wetflow.store.activeWorkflowRunId())
  const tool = ctx.wetflow.tools.get('batch_data_overview')
  expect(tool.execute({})).toEqual(overviewObservation(f.store.overview(f.project)))
  expect(tool.approvalRequired).toBe(false); expect(tool.mutatesState).toBe(false)
  await plugins.unload('batch-data')
  expect(() => tool.execute({})).toThrow('unloaded')
  expect(ctx.wetflow.tools.instructions()).not.toContain('batch_data_overview')
})

it('returns whole JSON pages under the observation cap without dropping rows or sample columns', () => {
  const f = fixture(); cleanup.push(() => f.store.close())
  const metric = f.store.addMetric(f.project, { code: 'GLU', name: '残糖浓度', unit: 'g/L' })
  for (let i = 0; i < 16; i++) {
    f.add(0, `T${i}`, `${i}.100`)
    f.store.record(f.project, f.run, { batchId: f.batches[0]!.id, metricId: metric.id, sample: `T${i}`, value: `${i}.000`, unit: 'g/L', source: 'a'.repeat(590), locator: 'x'.repeat(290) })
  }
  const seen = new Set<string>()
  // Traverse each row independently so size-based column pages cannot skip cells.
  for (let offset = 0; offset < 4; offset++) {
    let sampleOffset = 0
    for (;;) {
      const page = overviewObservation(f.store.overview(f.project, { offset, limit: 1, sampleOffset }))
      expect(JSON.stringify(page).length).toBeLessThan(6000)
      expect(() => JSON.parse(JSON.stringify(page))).not.toThrow()
      for (const row of page.rows) for (const cell of row.cells) if (cell.record) seen.add(cell.record.id)
      if (page.nextSampleOffset === null) break
      expect(page.nextSampleOffset).toBeGreaterThan(sampleOffset)
      sampleOffset = page.nextSampleOffset
    }
  }
  expect([...seen].sort()).toEqual(f.store.records(f.project, { limit: 500 }).items.map(row => row.id).sort())
  const queried = new Set<string>(); let offset = 0
  for (;;) {
    const page = observationPage(f.store.recordsWithContext(f.project, { offset, limit: 50 }))
    expect(JSON.stringify(page).length).toBeLessThan(6000)
    page.items.forEach(row => queried.add(row.id))
    if (page.nextOffset === null) break
    expect(page.nextOffset).toBeGreaterThan(offset)
    offset = page.nextOffset
  }
  expect([...queried].sort()).toEqual([...seen].sort())
})
