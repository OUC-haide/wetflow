// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResearchWorkspace } from '../src/web/ResearchWorkspace.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
interface Call { url: string; method: string; body: Record<string, unknown> }
let container: HTMLDivElement
let root: Root | undefined
let calls: Call[] = []
let saved: Record<string, unknown> = {}
let failSearch = false
let deferSearch = false
let resolveSearchResponse: ((response: Response) => void) | undefined
let listingLevel: string = 'metadata'
const source = { id: 'src-1', runId: 'run-1', provider: 'geo', externalId: 'GSE123', title: 'Growth data', url: 'https://example.org/GSE123', documentLevel: listingLevel, text: '', accession: 'GSE123', doi: '10.1000/example', authors: 'A. Researcher' }
const record = { id: 'record-1', runId: 'run-1', sourceId: 'src-1', createdAt: '2026-01-01', origin: 'literature', status: 'EXTRACTED', organism: 'E. coli', strain: 'K12', medium: 'M9', metric: 'biomass', unit: 'g/L', timeUnit: 'h', points: [{ time: 0, value: 0.1 }, { time: 12, value: 0.5 }, { time: 24, value: 1 }], evidenceQuote: 'Biomass increased', locator: 'Table 1' }
const job = { id: 'job-1', runId: 'run-1', query: 'E. coli growth', providers: ['europepmc'], status: 'INTERRUPTED', found: 1, errors: ['arXiv unavailable'], createdAt: '2026-01-01', updatedAt: '2026-01-01' }
let listedJob: typeof job = job
function ok(body: unknown): Response { return { ok: true, status: 200, json: async () => body } as Response }
function fail(status: number, error: string): Response { return { ok: false, status, json: async () => ({ error }) } as Response }
function installFetch() {
  calls = []; saved = {}; failSearch = false; deferSearch = false; resolveSearchResponse = undefined; listingLevel = 'metadata'; listedJob = job
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    let body: Record<string, unknown> = {}
    if (typeof init.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ url, method, body })
    if (url.includes('/profile') && method === 'GET') return ok({ runId: new URL(url, 'http://local').searchParams.get('runId'), enabled: false, goal: '', organism: '', strain: '', metric: 'biomass', conditions: '', customFields: [] })
    if (url.endsWith('/profile') && method === 'PUT') { saved = body; return ok(body) }
    if (url.includes('/jobs') && method === 'GET') return ok({ items: [listedJob] })
    if (url.endsWith('/jobs') && method === 'POST') { if (deferSearch) return new Promise<Response>(resolve => { resolveSearchResponse = resolve }); if (failSearch) return fail(503, 'Europe PMC 暂时不可用'); return ok({ ...job, id: 'job-new', query: String(body.query), status: 'SEARCHING', errors: [] }) }
    if (url.endsWith('/resume') && method === 'POST') return ok({ ...job, status: 'QUEUED' })
    if (url.endsWith('/cancel') && method === 'POST') return ok({ ...job, status: 'CANCELLED' })
    if (url.includes('/sources') && method === 'GET' && !url.match(/\/sources\/[^?]+/)) return ok({ items: [{ ...source, documentLevel: listingLevel }] })
    if (url.includes('/sources/src-1/fetch')) return ok({ ...source, documentLevel: 'abstract', abstract: 'Growth increased.', text: 'Growth increased.' })
    if (url.includes('/sources/src-1')) return ok({ ...source, documentLevel: 'abstract', text: 'Growth increased.' })
    if (url.includes('/records?') && method === 'GET') return ok({ items: new URL(url, 'http://local').searchParams.get('runId') === 'run-1' ? [record] : [] })
    if (url.endsWith('/records') && method === 'POST') return ok({ ...record, ...body, id: 'record-new' })
    if (url.includes('/schema?')) return ok({ tables: [{ name: 'measurements', columns: ['organism', 'metric', 'value'], description: '实验测量点' }] })
    if (url.endsWith('/query')) return ok({ columns: ['organism', 'count'], rows: [{ organism: 'E. coli', count: 3 }], truncated: false })
    if (url.includes('/export-modeling')) return ok({ datasetId: 'dataset-9', name: 'E. coli biomass' })
    return fail(404, `unhandled ${method} ${url}`)
  }))
}
async function flush(n = 20) { await act(async () => { for (let i = 0; i < n; i++) await Promise.resolve() }) }
async function render(runId = 'run-1') { await act(async () => { root = createRoot(container); root.render(<ResearchWorkspace runId={runId} />) }); await flush() }
function button(label: string) { const found = [...container.querySelectorAll('button')].find(node => node.textContent?.includes(label)); if (!found) throw new Error(`button ${label} not found`); return found as HTMLButtonElement }
function field(label: string) { const found = [...container.querySelectorAll('label')].find(node => node.textContent?.includes(label))?.querySelector('input,textarea,select'); if (!found) throw new Error(`field ${label} not found`); return found as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement }
function setFieldLast(label: string, value: string) { const input = [...container.querySelectorAll('label')].filter(node => node.textContent?.includes(label)).at(-1)?.querySelector('input,textarea,select') as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined; if (!input) throw new Error(`field ${label} not found`); const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) }
function setField(label: string, value: string) { const input = field(label); const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) }
async function click(label: string) { await act(async () => { button(label).dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await flush() }
async function tab(label: string) { await act(async () => { button(label).dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await flush() }
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = undefined; installFetch() })
afterEach(async () => { if (root) await act(async () => root?.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ResearchWorkspace', () => {
  it('saves a run-scoped profile and starts a search with selected providers', async () => {
    await render()
    setField('研究目标', '比较大肠杆菌生长条件')
    setField('物种', 'E. coli')
    await click('保存档案')
    expect(saved).toMatchObject({ runId: 'run-1', goal: '比较大肠杆菌生长条件', organism: 'E. coli', enabled: false })
    setField('检索词', 'E. coli biomass')
    await click('开始检索')
    expect(calls.find(call => call.url.endsWith('/jobs') && call.method === 'POST')?.body).toMatchObject({ runId: 'run-1', query: 'E. coli biomass', providers: ['europepmc', 'arxiv', 'geo'], limit: 20 })
    expect(container.textContent).toContain('检索命中不代表已提取实验数据')
  })
  it('keeps unsaved profile edits when the active-job poll refreshes other collections', async () => {
    listedJob = { ...job, status: 'SEARCHING' }
    await render()
    setField('研究目标', '尚未保存的研究目标')
    const profileReadsBeforePoll = calls.filter(call => call.url.includes('/profile') && call.method === 'GET').length
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 1700)) })
    expect((field('研究目标') as HTMLInputElement).value).toBe('尚未保存的研究目标')
    expect(calls.filter(call => call.url.includes('/profile') && call.method === 'GET')).toHaveLength(profileReadsBeforePoll)
  })
  it('surfaces provider errors and resumes interrupted jobs', async () => {
    failSearch = true
    await render()
    await click('开始检索')
    expect(container.textContent).toContain('Europe PMC 暂时不可用')
    await click('恢复')
    expect(calls.some(call => call.url.includes('/jobs/job-1/resume') && call.body.runId === 'run-1')).toBe(true)
  })
  it('distinguishes metadata from readable source content and displays the acquired level', async () => {
    await render()
    await tab('文献与数据源')
    expect(container.textContent).toContain('仅元数据')
    expect(container.textContent).toContain('许可信息未知')
    expect([...container.querySelectorAll('a')].some(link => link.href === 'https://doi.org/10.1000%2Fexample')).toBe(true)
    await click('获取摘要或正文')
    expect(container.textContent).toContain('摘要')
    expect(container.textContent).toContain('Growth increased.')
    expect(calls.some(call => call.url.includes('/sources/src-1/fetch'))).toBe(true)
  })
  it('submits record measurements with their selected source and evidence location', async () => {
    listingLevel = 'fulltext'
    await render()
    await tab('实验记录')
    setField('来源', 'src-1')
    setFieldLast('物种', 'E. coli')
    setField('原文证据引文', 'Biomass increased')
    setField('位置（页码、表格或段落）', 'Table 1')
    await click('保存记录')
    const submission = calls.find(call => call.url.endsWith('/records') && call.method === 'POST')
    expect(submission?.body).toMatchObject({ runId: 'run-1', sourceId: 'src-1', organism: 'E. coli', evidenceQuote: 'Biomass increased', locator: 'Table 1', points: [{ time: 0, value: 0.1 }, { time: 12, value: 0.8 }, { time: 24, value: 1.4 }] })
  })
  it('executes a real scoped query and renders returned rows with schema', async () => {
    await render()
    await tab('SQL 查询')
    await click('运行查询')
    expect(calls.find(call => call.url.endsWith('/query'))?.body).toMatchObject({ runId: 'run-1', sql: expect.stringContaining('SELECT') })
    expect(container.textContent).toContain('E. coli')
    expect(container.textContent).toContain('实验测量点')
  })
  it('exports an explicitly selected literature record and reports the returned dataset entry', async () => {
    await render()
    await tab('实验记录')
    await click('E. coli · biomass')
    await click('导出至生物过程建模')
    expect(calls.some(call => call.url.includes('/records/record-1/export-modeling') && call.body.runId === 'run-1')).toBe(true)
    expect(container.textContent).toContain('dataset-9')
    expect(container.textContent).toContain('growth_fit')
  })
  it('ignores a search response that arrives after switching runs', async () => {
    deferSearch = true
    await render()
    await act(async () => { button('开始检索').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { root?.render(<ResearchWorkspace runId="run-2" />) })
    resolveSearchResponse?.(ok({ ...job, id: 'stale-job', runId: 'run-1', query: 'stale' }))
    await flush()
    expect(container.textContent).not.toContain('stale')
    expect(calls.some(call => call.url.includes('runId=run-2'))).toBe(true)
  })
  it('drops old run state and requests every collection for the new run', async () => {
    await render()
    await act(async () => { root?.render(<ResearchWorkspace runId="run-2" />) })
    await flush()
    expect(calls.some(call => call.url.includes('runId=run-2'))).toBe(true)
    expect(calls.some(call => call.url.includes('/profile?runId=run-2'))).toBe(true)
    expect(container.textContent).not.toContain('E. coli · biomass')
  })
})
