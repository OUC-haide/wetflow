// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BatchFileImport } from '../src/web/plugins/BatchFileImport.js'
import type { ImportDocument } from '../src/batch-data/import-types.js'
import type { Metric } from '../src/batch-data/types.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
const metrics: Metric[] = [{ id: 'm', projectId: 'p', code: 'PMA', name: 'PMA 浓度', unit: 'g/L', lower: null, upper: null }]
const documentData: ImportDocument = { name: 'batch.xlsx', format: 'xlsx', warnings: [], tables: [
  { id: '1', label: '第一批', rows: [{ cells: ['sample', 'PMA (g/L)'], locator: '第一批!A1:B1' }, { cells: ['24 h', '10.500'], locator: '第一批!A2:B2' }] },
  { id: '2', label: '第二批', rows: [{ cells: ['sample', 'PMA (g/L)'], locator: '第二批!A1:B1' }, { cells: ['48 h', '20.100'], locator: '第二批!A2:B2' }] },
] }
function button(text: string) { return [...host.querySelectorAll('button')].find(x => x.textContent === text)! }
async function click(text: string) { await act(async () => button(text).click()) }
async function chooseFile() {
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['test'], 'batch.xlsx')] })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 30)) })
}
it('requires mapping and validation before a confirmed import and invalidates previews on sheet changes', async () => {
  const onComplete = vi.fn()
  const request = vi.fn(async (path: string) => path === '/import/file' ? documentData : path === '/import/preview'
    ? { newCount: 1, duplicateCount: 0, errorCount: 0, rows: [{ line: 2, status: 'new', message: '可以导入' }] } : { inserted: 1, skipped: 0 })
  await act(async () => root.render(<BatchFileImport batchId="B1" metrics={metrics} request={request as never} onComplete={onComplete}/>))
  await chooseFile()
  expect(host.textContent).toContain('第一批')
  expect(button('确认导入').disabled).toBe(true)
  expect(request.mock.calls.map(x => x[0])).toEqual(['/import/file'])
  await click('生成待导入记录')
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toContain('10.500')
  await click('校验预览')
  expect(button('确认导入').disabled).toBe(false)
  const sheet = host.querySelector('select')!
  await act(async () => { sheet.value = '2'; sheet.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(button('确认导入').disabled).toBe(true)
  expect(host.querySelector('textarea')).toBeNull()
  await click('生成待导入记录')
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toContain('20.100')
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).not.toContain('10.500')
  await click('校验预览')
  await click('确认导入')
  expect(onComplete).toHaveBeenCalledWith({ inserted: 1, skipped: 0 })
  expect(request.mock.calls.filter(x => x[0] === '/import')).toHaveLength(1)
})
it('shows extraction errors and cannot confirm or reuse earlier data after a failed upload', async () => {
  const request = vi.fn().mockRejectedValue(new Error('扫描版 PDF 请先进行 OCR'))
  await act(async () => root.render(<BatchFileImport batchId="B1" metrics={metrics} request={request} onComplete={vi.fn()}/>))
  await chooseFile()
  expect(host.querySelector('[role=alert]')?.textContent).toContain('OCR')
  expect(button('确认导入').disabled).toBe(true)
  expect(button('校验预览').disabled).toBe(true)
})
