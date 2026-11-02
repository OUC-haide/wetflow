import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, describe, expect, it } from 'vitest'
import { extractImportFile, pdfTableRows } from '../src/batch-data/import-file.js'
import { guessImportMapping, mappedImportCsv } from '../src/batch-data/import-mapping.js'
import { parseCsv } from '../src/batch-data/csv.js'
import { BatchDataStore } from '../src/batch-data/store.js'
import { createServer } from '../src/server.js'
import { pdfFixture } from './fixtures/pdf.js'

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
const url = (buffer: Uint8Array) => 'data:application/octet-stream;base64,' + Buffer.from(buffer).toString('base64')
function database() {
  const store = new BatchDataStore(':memory:')
  cleanups.push(() => store.close())
  const round = store.addRound('p', 'r', { number: 1, name: 'Round 1' })
  const batch = store.addBatch('p', 'r', { roundId: round.id, code: 'B1', name: 'Batch 1' })
  const metrics = [store.addMetric('p', { code: 'PMA', name: 'PMA 浓度', unit: 'g/L' }), store.addMetric('p', { code: 'OD', name: 'OD', unit: '' })]
  return { store, batch, metrics }
}
async function workbook() {
  const book = new ExcelJS.Workbook(), first = book.addWorksheet('发酵原始记录')
  first.addRow(['本文件是软件测试数据'])
  first.addRow(['采样点', 'PMA (g/L)', 'OD', '备注'])
  first.addRow(['24 h', '10.500000000001', 0, '第一条'])
  first.addRow(['48 h', 15.2, null, '缺少 OD'])
  first.getCell('B4').numFmt = '0.00'
  const other = book.addWorksheet('第二批')
  other.addRow(['sample', 'metric', 'value', 'unit'])
  other.addRow(['T1', 'PMA', '19.30', 'g/L'])
  return new Uint8Array(await book.xlsx.writeBuffer())
}
function tablePdf(): Buffer {
  const lines = [['sample', 'PMA (g/L)', 'OD'], ['24 h', '10.500', '0.20'], ['48 h', '', '0.40']]
  const stream = lines.map((row, y) => row.map((text, x) => !text ? '' : `BT /F1 12 Tf ${20 + x * 150} ${740 - y * 24} Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n')).join('\n')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [4 0 R] >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]
  let text = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const position = Buffer.byteLength(text)
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`
  return Buffer.from(text)
}
describe('file extraction and confirmed batch import', () => {
  it('reads multiple real XLSX sheets and imports wide data with exact text decimals, zero, missingness and provenance', async () => {
    const { store, batch, metrics } = database()
    const doc = await extractImportFile('发酵数据.xlsx', url(await workbook()))
    expect(doc.tables.map(x => x.label)).toEqual(['发酵原始记录', '第二批'])
    const table = doc.tables[0]!, mapping = guessImportMapping(table, metrics)
    expect(mapping.headerRow).toBe(1)
    const csv = mappedImportCsv(doc, table, mapping, metrics)
    expect(store.catalogue('p').recordCount).toBe(0)
    expect(store.preview('p', batch.id, csv)).toMatchObject({ newCount: 3, errorCount: 0 })
    expect(store.import('p', 'r', batch.id, csv)).toEqual({ inserted: 3, skipped: 0 })
    const records = store.records('p').items
    expect(records.find(x => x.sample === '24 h' && x.metricId === metrics[0]!.id)).toMatchObject({ value: '10.500000000001', source: '发酵数据.xlsx', locator: '发酵原始记录!A3:D3；第 2 列' })
    expect(records.find(x => x.sample === '48 h')?.value).toBe('15.20')
    expect(records.some(x => x.value === '0')).toBe(true)
    expect(store.import('p', 'r', batch.id, csv)).toEqual({ inserted: 0, skipped: 3 })
    const other = doc.tables[1]!, otherCsv = mappedImportCsv(doc, other, guessImportMapping(other, metrics), metrics)
    expect(parseCsv(otherCsv)[1]?.slice(0, 5)).toEqual(['T1', 'PMA', '19.30', 'g/L', '发酵数据.xlsx'])
  })
  it('reads an actual PDF table without shifting an empty middle cell and retains its page location', async () => {
    const { store, batch, metrics } = database()
    const doc = await extractImportFile('table.pdf', url(tablePdf()))
    const table = doc.tables[0]!
    expect(table.rows.map(x => x.cells)).toEqual([['sample', 'PMA (g/L)', 'OD'], ['24 h', '10.500', '0.20'], ['48 h', '', '0.40']])
    const csv = mappedImportCsv(doc, table, guessImportMapping(table, metrics), metrics)
    expect(store.import('p', 'r', batch.id, csv).inserted).toBe(3)
    expect(store.records('p').items.every(x => x.source === 'table.pdf' && x.locator.startsWith('第 1 页'))).toBe(true)
  })
  it('keeps right-aligned PDF numbers in the same columns', () => {
    const rows = pdfTableRows([
      { text: 'sample', x: 20, y: 20, width: 40, height: 12 }, { text: 'PMA', x: 150, y: 20, width: 30, height: 12 }, { text: 'OD', x: 300, y: 20, width: 20, height: 12 },
      { text: 'T1', x: 20, y: 40, width: 20, height: 12 }, { text: '0.5', x: 240, y: 40, width: 30, height: 12 }, { text: '2', x: 330, y: 40, width: 10, height: 12 },
    ], 1)
    expect(rows[1]?.cells).toEqual(['T1', '0.5', '2'])
  })
  it('does not manufacture records for a scanned or text-only PDF or invalid extension', async () => {
    await expect(extractImportFile('scan.pdf', url(pdfFixture([''])))).rejects.toThrow('OCR')
    await expect(extractImportFile('paragraph.pdf', url(pdfFixture(['No table here'])))).rejects.toThrow('文字表格')
    await expect(extractImportFile('book.xlsx', url(Buffer.from('not a workbook')))).rejects.toThrow('工作簿')
    await expect(extractImportFile('book.xls', url(Buffer.from('x')))).rejects.toThrow('.xlsx')
  })
  it('retains explicit units so mismatches block the entire import and does not guess undefined metrics', async () => {
    const { store, batch, metrics } = database()
    const doc = await extractImportFile('data.xlsx', url(await workbook())), table = doc.tables[0]!
    table.rows[1]!.cells[1] = 'PMA (mg/L)'
    const mapping = guessImportMapping(table, metrics); mapping.wideMetrics[1] = 'PMA'
    const csv = mappedImportCsv(doc, table, mapping, metrics)
    expect(store.preview('p', batch.id, csv).errorCount).toBe(2)
    expect(() => store.import('p', 'r', batch.id, csv)).toThrow('未写入')
    expect(store.catalogue('p').recordCount).toBe(0)
    mapping.wideMetrics[1] = 'MISSING'
    expect(() => mappedImportCsv(doc, table, mapping, metrics)).toThrow('尚未定义')
  })
  it('flags formula cells without cached results instead of treating them as zero or blank', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Data')
    sheet.addRow(['sample', 'PMA (g/L)']); sheet.addRow(['T1', { formula: '1+2' }])
    const doc = await extractImportFile('formula.xlsx', url(new Uint8Array(await book.xlsx.writeBuffer())))
    expect(doc.warnings.join(' ')).toContain('公式')
    expect(doc.tables[0]?.rows[1]?.cells[1]).toBe('#公式无缓存结果')
    const { store, batch, metrics } = database(), table = doc.tables[0]!
    expect(store.preview('p', batch.id, mappedImportCsv(doc, table, guessImportMapping(table, metrics), metrics)).errorCount).toBe(1)
  })
  it('handles the real file endpoint, requires current-project ownership and remains disabled with its plugin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-file-import-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const app = await createServer({ dbPath: join(dir, 'core.db'), settingsPath: join(dir, 'model.json'), industrialDbPath: join(dir, 'industrial.db'), industrialSettingsPath: join(dir, 'industrial.json'), modelingDataDir: join(dir, 'modeling'), serveWeb: false })
    cleanups.push(() => app.close())
    const round = (await app.inject({ method: 'POST', url: '/api/batch-data/rounds', payload: { name: 'test', number: 1 } })).json()
    const batch = (await app.inject({ method: 'POST', url: '/api/batch-data/batches', payload: { roundId: round.id, code: 'B1', name: 'test' } })).json()
    const payload = { batchId: batch.id, name: 'data.xlsx', dataUrl: url(await workbook()) }
    const response = await app.inject({ method: 'POST', url: '/api/batch-data/import/file', payload })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().tables).toHaveLength(2)
    expect((await app.inject('/api/batch-data/catalog')).json().recordCount).toBe(0)
    for (const metric of [{ code: 'PMA', name: 'PMA 浓度', unit: 'g/L' }, { code: 'OD', name: 'OD', unit: '' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/batch-data/metrics', payload: metric })).statusCode).toBe(200)
    }
    const metrics = (await app.inject('/api/batch-data/catalog')).json().metrics
    const extracted = response.json(), table = extracted.tables[0]
    const csv = mappedImportCsv(extracted, table, guessImportMapping(table, metrics), metrics)
    const preview = await app.inject({ method: 'POST', url: '/api/batch-data/import/preview', payload: { batchId: batch.id, csv } })
    expect(preview.json()).toMatchObject({ newCount: 3, errorCount: 0 })
    expect((await app.inject('/api/batch-data/catalog')).json().recordCount).toBe(0)
    const imported = await app.inject({ method: 'POST', url: '/api/batch-data/import', payload: { batchId: batch.id, csv } })
    expect(imported.json()).toEqual({ inserted: 3, skipped: 0 })
    const recorded = (await app.inject(`/api/batch-data/records?batchId=${batch.id}`)).json()
    expect(recorded.total).toBe(3)
    expect(recorded.items.some((x: { value: string; source: string }) => x.value === '10.500000000001' && x.source === 'data.xlsx')).toBe(true)
    expect((await app.inject({ method: 'POST', url: '/api/batch-data/import/file', payload, headers: { 'x-wetflow-project': 'wrong-project' } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/batch-data/import/file', payload: { ...payload, batchId: 'not-owned' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/batch-data/import/file', payload: { ...payload, name: 'bad.pdf', dataUrl: url(Buffer.from('%PDF-invalid')) } })).statusCode).toBe(400)
    await app.inject({ method: 'POST', url: '/api/plugins/batch-data/unload' })
    expect((await app.inject({ method: 'POST', url: '/api/batch-data/import/file', payload })).statusCode).toBe(503)
  })
})
