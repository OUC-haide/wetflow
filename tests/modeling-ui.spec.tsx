// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelingWorkspace } from '../src/web/ModelingWorkspace.js'
import type { ModelMethod, ModelResult, ModelTask } from '../src/modeling/types.js'

// React 18 requires this flag for act() outside its own test renderer.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Call { url: string; method: string; body: Record<string, unknown> }
interface MockResponse { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }

let container: HTMLDivElement
let root: Root | undefined
let calls: Call[] = []

function ok(body: unknown): MockResponse {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function fail(status: number, error: string): MockResponse {
  return { ok: false, status, json: async () => ({ error }), text: async () => JSON.stringify({ error }) }
}

type Handler = (url: string, init: RequestInit, path: string) => MockResponse | Promise<MockResponse>

function installFetch(handler: Handler): void {
  calls = []
  const mock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: Record<string, unknown> = {}
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) as Record<string, unknown> } catch { body = { raw: init.body } }
    }
    calls.push({ url, method, body })
    return (await handler(url, init ?? {}, url.split('?')[0]!)) as unknown as Response
  })
  vi.stubGlobal('fetch', mock)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

const MONOD_METHOD: ModelMethod = {
  id: 'monod_batch',
  version: 'monod-conservative-rk4-2',
  label: 'Monod batch simulation',
  description: '质量守恒的 Monod 批次积分。',
  inputSchema: {
    type: 'object',
    required: ['initialBiomass', 'initialSubstrate', 'muMax', 'halfSaturation', 'yield', 'duration', 'timeStep'],
    additionalProperties: false,
    properties: {
      initialBiomass: { type: 'number', exclusiveMinimum: 0, unit: 'g/L' },
      initialSubstrate: { type: 'number', minimum: 0, unit: 'g/L' },
      muMax: { type: 'number', exclusiveMinimum: 0, unit: '1/h' },
      halfSaturation: { type: 'number', exclusiveMinimum: 0, unit: 'g/L' },
      yield: { type: 'number', exclusiveMinimum: 0, unit: 'g-biomass/g-substrate' },
      duration: { type: 'number', exclusiveMinimum: 0, unit: 'h' },
      timeStep: { type: 'number', exclusiveMinimum: 0, unit: 'h' },
    },
  },
  units: { time: 'h', biomass: 'g/L', substrate: 'g/L' },
  assumptions: ['X + Y*S 守恒'],
  limitations: ['理想化预测'],
}

const GROWTH_METHOD: ModelMethod = {
  id: 'growth_fit',
  version: 'log-linear-ols-2',
  label: 'Exponential growth fit',
  description: '对 log 生物量做 OLS。',
  inputSchema: {
    type: 'object',
    required: ['datasetId'],
    additionalProperties: false,
    properties: { datasetId: { type: 'string', minLength: 1 } },
  },
  units: { time: 'h', biomass: 'g/L', growthRate: '1/h', doublingTime: 'h' },
  assumptions: ['所有点处于指数生长期'],
  limitations: ['不自动检测生长阶段'],
}

const MONOD_PARAMETERS = {
  initialBiomass: 0.1, initialSubstrate: 10, muMax: 0.4, halfSaturation: 0.1, yield: 0.5, duration: 24, timeStep: 0.1,
}

function makeTask(id: string, overrides: Partial<ModelTask> = {}): ModelTask {
  return {
    id,
    runId: 'run-1',
    method: 'monod_batch',
    methodVersion: 'monod-conservative-rk4-2',
    title: `task ${id}`,
    status: 'SUCCEEDED',
    parameters: { ...MONOD_PARAMETERS },
    budget: { wallTimeMs: 30_000, maxOutputRows: 5_000 },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ModelTask
}

function makeResult(taskId: string, overrides: Partial<ModelResult> = {}): ModelResult {
  return {
    taskId,
    method: 'monod_batch',
    methodVersion: 'monod-conservative-rk4-2',
    summary: { finalBiomass: 1.05, finalSubstrate: 0.075, outputRows: 2 },
    metrics: { biomassIncrease: 0.95 },
    units: { biomassIncrease: 'g/L', finalBiomass: 'g/L', finalSubstrate: 'g/L' },
    assumptions: ['X + Y*S 守恒'],
    limitations: ['理想化预测'],
    artifacts: [
      { id: 'trajectory', name: 'output.csv', mediaType: 'text/csv', sizeBytes: 64 },
      { id: 'result', name: 'result.json', mediaType: 'application/json', sizeBytes: 256 },
    ],
    ...overrides,
  } as ModelResult
}

const MONOD_CSV = 'time_h,biomass_g_L,substrate_g_L\n0,1,0.1\n1,1.05,0.075\n'
const GROWTH_FIT_CSV = 'time_h,observed_biomass_g_L,fitted_biomass_g_L,log_residual\n0,0.1,0.1,0\n1,0.2,0.2,-2.2e-16\n2,0.4,0.4,-1.1e-16\n3,0.8,0.8,0\n4,1.6,1.6,-1.1e-16\n'

async function renderWorkspace(runId = 'run-1'): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<ModelingWorkspace runId={runId} />)
  })
}

async function flush(times = 16): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) await Promise.resolve()
  })
}

function findField(labelText: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const label = [...container.querySelectorAll('label')].find(candidate => candidate.textContent?.includes(labelText))
  const field = label?.querySelector('input, select, textarea')
  if (!field) throw new Error(`field not found for label: ${labelText}`)
  return field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
}

function findButton(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(text))
  if (!button) throw new Error(`button not found: ${text}`)
  return button as HTMLButtonElement
}

function setValue(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  const prototype = field instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new window.Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

async function fill(labelText: string, value: string): Promise<void> {
  await act(async () => { setValue(findField(labelText), value) })
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
}

function makeFile(name: string, content: string | Uint8Array): File {
  const file = new File([content as BlobPart], name, { type: 'text/csv' })
  if (typeof (file as { text?: unknown }).text !== 'function') {
    const text = typeof content === 'string' ? content : ''
    Object.defineProperty(file, 'text', { value: async () => text })
  }
  return file
}

async function chooseFile(file: File): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: { 0: file, length: 1, item: (index: number) => (index === 0 ? file : null) },
  })
  await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })) })
}

function baseHandler(options: {
  methods?: ModelMethod[]
  datasets?: unknown[]
  tasks?: () => ModelTask[]
  results?: Record<string, ModelResult>
}): Handler {
  return (url, init, path) => {
    const method = (init.method ?? 'GET').toUpperCase()
    if (path === '/api/modeling/methods') return ok({ items: options.methods ?? [MONOD_METHOD, GROWTH_METHOD] })
    if (path === '/api/modeling/datasets' && method === 'GET') return ok({ items: options.datasets ?? [] })
    if (path === '/api/modeling/tasks' && method === 'GET') return ok({ items: options.tasks?.() ?? [] })
    const resultMatch = path.match(/^\/api\/modeling\/tasks\/([^/]+)\/result$/)
    if (resultMatch && options.results?.[resultMatch[1]!]) return ok(options.results[resultMatch[1]!])
    if (path.includes('/artifacts/')) return ok(MONOD_CSV)
    return fail(404, `unhandled ${method} ${path}`)
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = undefined
})

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ModelingWorkspace lifecycle regressions', () => {
  it('renders method units and submits the exact timeStep contract payload', async () => {
    let submitted: Record<string, unknown> | undefined
    installFetch((_url, init, path) => {
      if (path === '/api/modeling/methods') return ok({ items: [MONOD_METHOD, GROWTH_METHOD] })
      if (path === '/api/modeling/datasets') return ok({ items: [] })
      if (path === '/api/modeling/tasks' && (init.method ?? 'GET') === 'GET') return ok({ items: [] })
      if (path === '/api/modeling/tasks' && init.method === 'POST') {
        submitted = JSON.parse(String(init.body)) as Record<string, unknown>
        return ok(makeTask('task-new', { status: 'QUEUED', parameters: submitted.parameters as Record<string, number> }))
      }
      return fail(404, `unhandled ${path}`)
    })
    await renderWorkspace()
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('g/L')
    expect(text).toContain('1/h')
    expect(text).toContain('模拟时长')
    expect(text).toContain('vmonod-conservative-rk4-2')

    await fill('X₀', '1')
    await fill('S₀', '0.1')
    await fill('μmax', '10')
    await fill('Ks', '0.1')
    await fill('Yx/s', '0.5')
    await fill('模拟时长', '1')
    await fill('积分步长', '0.25')
    await fill('任务标题', 'coarse run')
    await click(findButton('提交任务'))
    await flush()

    expect(submitted).toBeDefined()
    expect(submitted).toMatchObject({
      runId: 'run-1',
      method: 'monod_batch',
      title: 'coarse run',
      budget: { wallTimeMs: 30_000, maxOutputRows: 5 },
      parameters: {
        initialBiomass: 1, initialSubstrate: 0.1, muMax: 10, halfSaturation: 0.1, yield: 0.5, duration: 1, timeStep: 0.25,
      },
    })
    expect((submitted?.parameters as Record<string, unknown>).timeStep).toBe(0.25)
    // Units travelled with the label, not a silent arbitrary-unit default.
    expect(container.textContent).toContain('积分步长')
  })

  it('ignores a stale result that resolves after another task was selected', async () => {
    const slow = deferred<MockResponse>()
    installFetch((url, _init, path) => {
      if (path === '/api/modeling/methods') return ok({ items: [MONOD_METHOD] })
      if (path === '/api/modeling/datasets') return ok({ items: [] })
      if (path === '/api/modeling/tasks') return ok({ items: [makeTask('task-a'), makeTask('task-b')] })
      if (path === '/api/modeling/tasks/task-a/result') return slow.promise
      if (path === '/api/modeling/tasks/task-b/result') return ok(makeResult('task-b', { metrics: { biomassIncrease: 222 } }))
      if (url.includes('/artifacts/')) return ok(MONOD_CSV)
      return fail(404, `unhandled ${path}`)
    })
    await renderWorkspace()
    await flush()

    await click(findButton('task task-a'))
    await flush(4)
    await click(findButton('task task-b'))
    await flush()
    const metricsAfterSwitch = container.querySelector('.modeling-metrics')?.textContent ?? ''
    expect(metricsAfterSwitch).toContain('222')
    expect(metricsAfterSwitch).not.toContain('111')

    // Task A's slow response arrives after B was selected; it must be dropped.
    slow.resolve(ok(makeResult('task-a', { metrics: { biomassIncrease: 111 } })))
    await flush()
    const metricsAfterStale = container.querySelector('.modeling-metrics')?.textContent ?? ''
    expect(metricsAfterStale).toContain('222')
    expect(metricsAfterStale).not.toContain('111')
    expect(container.querySelector('[data-testid="modeling-result"]')).not.toBeNull()
  })

  it('resets registration, experiment and result when a new task is submitted', async () => {
    const registered = makeTask('task-a', { predictionId: 'pred-1', linkedExperiment: 'ELN-1' })
    installFetch((_url, init, path) => {
      if (path === '/api/modeling/methods') return ok({ items: [MONOD_METHOD] })
      if (path === '/api/modeling/datasets') return ok({ items: [] })
      if (path === '/api/modeling/tasks' && (init.method ?? 'GET') === 'GET') return ok({ items: [registered] })
      if (path === '/api/modeling/tasks/task-a/result') return ok(makeResult('task-a', { metrics: { biomassIncrease: 111 } }))
      if (path === '/api/modeling/tasks/task-b/result') return ok(makeResult('task-b', { metrics: { biomassIncrease: 222 } }))
      if (path === '/api/modeling/tasks' && init.method === 'POST') return ok(makeTask('task-b', { status: 'SUCCEEDED' }))
      if (_url.includes('/artifacts/')) return ok(MONOD_CSV)
      return fail(404, `unhandled ${path}`)
    })
    await renderWorkspace()
    await flush()

    await click(findButton('task task-a'))
    await flush()
    const firstPanel = container.querySelector('[data-testid="modeling-result"]')
    expect(firstPanel?.textContent).toContain('pred-1')
    expect(firstPanel?.textContent).toContain('ELN-1')
    expect(firstPanel?.querySelector('[data-testid="trajectory-table"]')).not.toBeNull()
    // Monod biomass and substrate share one g/L axis; both series are plotted.
    const monodLegend = firstPanel?.querySelector('.modeling-chart-legend')?.textContent ?? ''
    expect(monodLegend).toContain('biomass_g_L')
    expect(monodLegend).toContain('substrate_g_L')
    expect(firstPanel?.querySelectorAll('.modeling-chart polyline').length).toBe(2)
    expect(firstPanel?.querySelector('[data-testid="chart-y-unit"]')?.textContent).toBe('g/L')
    expect(firstPanel?.querySelector('[data-testid="chart-omitted-note"]')).toBeNull()

    await click(findButton('填入示例参数'))
    await click(findButton('提交任务'))
    await flush()

    const secondPanel = container.querySelector('[data-testid="modeling-result"]')
    expect(secondPanel).not.toBeNull()
    expect(secondPanel?.textContent).toContain('222')
    expect(secondPanel?.textContent).not.toContain('pred-1')
    expect(secondPanel?.textContent).not.toContain('ELN-1')
    expect(findButton('登记为预测').disabled).toBe(false)
    expect((findField('实验记录引用') as HTMLInputElement).value).toBe('')
  })

  it('rejects an oversized CSV before reading it and posts a bounded file', async () => {
    let posted: Record<string, unknown> | undefined
    installFetch((_url, init, path) => {
      if (path === '/api/modeling/methods') return ok({ items: [MONOD_METHOD] })
      if (path === '/api/modeling/datasets' && (init.method ?? 'GET') === 'GET') return ok({ items: [] })
      if (path === '/api/modeling/datasets' && init.method === 'POST') {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>
        return ok({ id: 'dataset-1', runId: 'run-1', name: posted.name, columns: ['time', 'biomass'], rowCount: 3, createdAt: '2026-01-01T00:00:00.000Z' })
      }
      if (path === '/api/modeling/tasks') return ok({ items: [] })
      return fail(404, `unhandled ${path}`)
    })
    await renderWorkspace()
    await flush()

    await chooseFile(makeFile('huge.csv', new Uint8Array(2_000_001)))
    await click(findButton('导入 CSV'))
    await flush()
    expect(calls.some(call => call.method === 'POST' && call.url.startsWith('/api/modeling/datasets'))).toBe(false)
    expect(container.querySelector('[role="alert"]')?.textContent ?? '').toContain('超过')

    await chooseFile(makeFile('growth.csv', 'time,biomass\n0,0.1\n1,0.2\n2,0.4\n'))
    await click(findButton('导入 CSV'))
    await flush()
    expect(posted).toMatchObject({ runId: 'run-1', name: 'growth.csv', csv: 'time,biomass\n0,0.1\n1,0.2\n2,0.4\n' })
  })

  it('shows a failed task error and never requests a result for it', async () => {
    installFetch(baseHandler({
      tasks: () => [makeTask('task-f', { status: 'FAILED', error: 'worker exploded' })],
      results: { 'task-f': makeResult('task-f') },
    }))
    await renderWorkspace()
    await flush()

    await click(findButton('task task-f'))
    await flush()
    expect(container.textContent).toContain('worker exploded')
    expect(calls.some(call => call.url.includes('/tasks/task-f/result'))).toBe(false)
    expect(container.querySelector('[data-testid="modeling-result"]')).toBeNull()
    expect(container.querySelector('[data-testid="modeling-result-status"]')?.textContent ?? '').toContain('没有可展示的结果')
  })

  it('stops polling once every task reaches a terminal state', async () => {
    vi.useFakeTimers()
    let tasksCalls = 0
    installFetch((_url, init, path) => {
      if (path === '/api/modeling/methods') return ok({ items: [MONOD_METHOD] })
      if (path === '/api/modeling/datasets') return ok({ items: [] })
      if (path === '/api/modeling/tasks' && (init.method ?? 'GET') === 'GET') {
        tasksCalls += 1
        const status = tasksCalls >= 3 ? 'SUCCEEDED' : 'RUNNING'
        return ok({ items: [makeTask('task-p', { status })] })
      }
      if (path === '/api/modeling/tasks/task-p/result') return ok(makeResult('task-p'))
      if (path.includes('/artifacts/')) return ok(MONOD_CSV)
      return fail(404, `unhandled ${path}`)
    })
    await renderWorkspace()
    await flush()
    expect(tasksCalls).toBe(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    await flush()
    expect(tasksCalls).toBe(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    await flush()
    expect(tasksCalls).toBe(3)

    const settledCalls = tasksCalls
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await flush()
    expect(tasksCalls).toBe(settledCalls)
  })

  it('clears the polling timer on unmount', async () => {
    vi.useFakeTimers()
    let tasksCalls = 0
    installFetch((_url, init, path) => {
      if (path === '/api/modeling/methods') return ok({ items: [MONOD_METHOD] })
      if (path === '/api/modeling/datasets') return ok({ items: [] })
      if (path === '/api/modeling/tasks' && (init.method ?? 'GET') === 'GET') {
        tasksCalls += 1
        return ok({ items: [makeTask('task-p', { status: 'RUNNING' })] })
      }
      return fail(404, `unhandled ${path}`)
    })
    await renderWorkspace()
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    await flush()
    expect(tasksCalls).toBe(2)

    await act(async () => { root?.unmount() })
    root = undefined
    const beforeUnmount = tasksCalls
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await flush()
    expect(tasksCalls).toBe(beforeUnmount)
  })

  it('registers editable concise prediction text and links an experiment as PROPOSED', async () => {
    let predictionBody: Record<string, unknown> | undefined
    let experimentBody: Record<string, unknown> | undefined
    const task = makeTask('task-r')
    installFetch((_url, init, path) => {
      if (path === '/api/modeling/methods') return ok({ items: [MONOD_METHOD] })
      if (path === '/api/modeling/datasets') return ok({ items: [] })
      if (path === '/api/modeling/tasks' && (init.method ?? 'GET') === 'GET') return ok({ items: [task] })
      if (path === '/api/modeling/tasks/task-r/result') return ok(makeResult('task-r'))
      if (path === '/api/modeling/tasks/task-r/prediction') {
        predictionBody = JSON.parse(String(init.body)) as Record<string, unknown>
        return ok({ task: { ...task, predictionId: 'pred-9' }, predictionId: 'pred-9' })
      }
      if (path === '/api/modeling/tasks/task-r/experiment') {
        experimentBody = JSON.parse(String(init.body)) as Record<string, unknown>
        return ok({ ...task, predictionId: 'pred-9', linkedExperiment: 'ELN-9', linkedExperimentNote: 'follow-up' })
      }
      if (_url.includes('/artifacts/')) return ok(MONOD_CSV)
      return fail(404, `unhandled ${path}`)
    })
    await renderWorkspace()
    await flush()

    await click(findButton('task task-r'))
    await flush()
    const predictionField = findField('预测摘要') as HTMLTextAreaElement
    expect(predictionField.value).toContain('Monod')
    expect((findField('不确定度声明') as HTMLTextAreaElement).value).toBe('')

    await fill('预测摘要', '预测：终点生物量 1.05 g/L。')
    await click(findButton('登记为预测'))
    await flush()

    expect(predictionBody).toBeDefined()
    expect(predictionBody?.prediction).toBe('预测：终点生物量 1.05 g/L。')
    expect(String(predictionBody?.conditions ?? '').length).toBeGreaterThan(0)
    // Metrics are fit/model outputs, never silently copied into uncertainty.
    expect(predictionBody?.uncertainty).toBe('')
    expect(JSON.stringify(predictionBody)).not.toContain('biomassIncrease')
    expect(container.textContent).toContain('pred-9')

    await fill('实验记录引用', 'ELN-9')
    // UI note cap follows the frozen service limit (600), not the old 2000.
    expect((findField('关联备注') as HTMLInputElement).maxLength).toBe(600)
    await fill('关联备注', 'follow-up')
    await click(findButton('关联实验'))
    await flush()

    expect(experimentBody).toMatchObject({ runId: 'run-1', experimentRef: 'ELN-9', note: 'follow-up' })
    const panel = container.querySelector('[data-testid="modeling-result"]')
    expect(panel?.textContent).toContain('PROPOSED')
    expect(panel?.textContent).toContain('ELN-9')
  })

  it('submits growth_fit with a datasetId and no numeric parameters', async () => {
    let submitted: Record<string, unknown> | undefined
    const dataset = {
      id: 'dataset-1', runId: 'run-1', name: 'growth.csv', columns: ['time', 'biomass'], rowCount: 4,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    installFetch((_url, init, path) => {
      if (path === '/api/modeling/methods') return ok({ items: [MONOD_METHOD, GROWTH_METHOD] })
      if (path === '/api/modeling/datasets' && (init.method ?? 'GET') === 'GET') return ok({ items: [dataset] })
      if (path === '/api/modeling/tasks' && (init.method ?? 'GET') === 'GET') return ok({ items: [] })
      if (path === '/api/modeling/tasks' && init.method === 'POST') {
        submitted = JSON.parse(String(init.body)) as Record<string, unknown>
        return ok(makeTask('task-g', { method: 'growth_fit', methodVersion: 'log-linear-ols-2', parameters: {}, status: 'QUEUED' }))
      }
      return fail(404, `unhandled ${path}`)
    })
    await renderWorkspace()
    await flush()

    await fill('方法', 'growth_fit')
    await fill('输入数据集', 'dataset-1')
    await click(findButton('提交任务'))
    await flush()

    expect(submitted).toMatchObject({
      runId: 'run-1',
      method: 'growth_fit',
      parameters: {},
      datasetId: 'dataset-1',
      budget: { wallTimeMs: 30_000, maxOutputRows: 4 },
    })
    expect(submitted).not.toHaveProperty('title')
  })

  it('keeps an incompatible log_residual out of the biomass chart but visible in the table', async () => {
    const task = makeTask('task-axis', {
      method: 'growth_fit', methodVersion: 'log-linear-ols-2', parameters: {}, datasetId: 'dataset-1',
    })
    const result = makeResult('task-axis', {
      method: 'growth_fit',
      methodVersion: 'log-linear-ols-2',
      summary: { growthRate: Math.LN2, doublingTime: 1, rSquared: 1 },
      metrics: { growthRate: Math.LN2, doublingTime: 1 },
      diagnostics: { rSquared: 1, logRmse: 1.2e-16, n: 5 },
      units: { growthRate: '1/h', doublingTime: 'h', rSquared: 'dimensionless', logRmse: 'ln(g/L)', n: 'points' },
    })
    installFetch((_url, _init, path) => {
      if (path === '/api/modeling/methods') return ok({ items: [GROWTH_METHOD] })
      if (path === '/api/modeling/datasets') {
        return ok({ items: [{ id: 'dataset-1', runId: 'run-1', name: 'growth.csv', columns: ['time', 'biomass'], rowCount: 5, createdAt: '2026-01-01T00:00:00.000Z' }] })
      }
      if (path === '/api/modeling/tasks') return ok({ items: [task] })
      if (path === '/api/modeling/tasks/task-axis/result') return ok(result)
      if (path.includes('/artifacts/')) return ok(GROWTH_FIT_CSV)
      return fail(404, `unhandled ${path}`)
    })
    await renderWorkspace()
    await flush()
    await click(findButton('task task-axis'))
    await flush()

    const panel = container.querySelector('[data-testid="modeling-result"]')
    expect(panel).not.toBeNull()
    // The residual stays in the data table (and the CSV download)...
    const tableHeaders = [...(panel?.querySelectorAll('[data-testid="trajectory-table"] th') ?? [])].map(cell => cell.textContent)
    expect(tableHeaders).toContain('log_residual')
    // ...but must not share the biomass (g/L) y-axis.
    const legend = panel?.querySelector('.modeling-chart-legend')?.textContent ?? ''
    expect(legend).toContain('observed_biomass_g_L')
    expect(legend).toContain('fitted_biomass_g_L')
    expect(legend).not.toContain('log_residual')
    expect(panel?.querySelectorAll('.modeling-chart polyline').length).toBe(2)
    expect(panel?.querySelector('[data-testid="chart-y-unit"]')?.textContent).toBe('g/L')
    const omittedNote = panel?.querySelector('[data-testid="chart-omitted-note"]')?.textContent ?? ''
    expect(omittedNote).toContain('log_residual')
    const chartAria = panel?.querySelector('.modeling-chart')?.getAttribute('aria-label') ?? ''
    expect(chartAria).toContain('g/L')
    expect(chartAria).not.toContain('log_residual')
  })
})
