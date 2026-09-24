import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IndustrialStore } from '../src/industrial/index.js'
import { ToolRegistry, createWetFlowTools } from '../src/agent/tools.js'
import { INDUSTRIAL_TOOL_SCHEMAS, registerIndustrialTools } from '../src/agent/industrial-tools.js'
import { createWetFlowContext } from '../src/cordis.js'
import { WetFlowStore } from '../src/core/store.js'

const temporary: string[] = []
const industrialStores: IndustrialStore[] = []
const workflowStores: WetFlowStore[] = []

afterEach(() => {
  for (const store of industrialStores.splice(0)) store.close()
  for (const store of workflowStores.splice(0)) store.close()
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ACTOR = { id: 'test-agent', role: 'agent' }
const RUN = 'run-tools'

function workingDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

function harness(): { registry: ToolRegistry; store: IndustrialStore } {
  const dir = workingDir('wetflow-industrial-tools-')
  const store = new IndustrialStore(join(dir, 'industrial.db'))
  industrialStores.push(store)
  const registry = new ToolRegistry()
  registerIndustrialTools(registry, {
    store: () => store,
    resolveRunId: candidate => {
      const runId = candidate?.trim() || RUN
      if (runId !== RUN) throw new Error('工作流运行不存在。')
      return runId
    },
    actor: ACTOR,
  })
  return { registry, store }
}

function run<T = unknown>(
  registry: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
  context: { userMessage: string } = { userMessage: authorizedUserMessage(input) },
): T {
  return registry.get(name).execute(input, context) as T
}

/**
 * The write authorization boundary requires the value to come from the user's
 * own message. These business tests synthesize the smallest such message from
 * the input; explicit refusal cases pass a narrower context instead.
 */
function authorizedUserMessage(input: Record<string, unknown>): string {
  const key = typeof input.parameterKey === 'string' ? input.parameterKey : ''
  const title = typeof input.title === 'string' ? input.title : ''
  const value = input.value ?? input.observedValue
  const unit = typeof input.unit === 'string' ? input.unit : ''
  const parts = ['record']
  if (key) parts.push(key)
  if (title) parts.push(title)
  if (value !== undefined && value !== null && value !== '') parts.push(`${String(value)} ${unit}`.trim())
  return parts.join(' ')
}

function seedParameter(store: IndustrialStore, overrides: Record<string, unknown> = {}) {
  return store.saveParameter(RUN, {
    key: 'TEMP',
    name: '发酵温度',
    classification: 'CPP',
    unit: '°C',
    target: 25,
    lowerLimit: 20,
    upperLimit: 30,
    ...overrides,
  }, ACTOR)
}

describe('industrial agent tools', () => {
  it('exposes an explicit JSON schema for every tool and never leaks execute', () => {
    const { registry } = harness()
    const definitions = registry.definitions()
    const names = Object.keys(INDUSTRIAL_TOOL_SCHEMAS)
    expect(names).toHaveLength(5)
    for (const name of names) {
      const definition = definitions.find(item => item.name === name)
      expect(definition, `missing definition for ${name}`).toBeDefined()
      expect(definition?.parameters).toMatchObject({ type: 'object', additionalProperties: false })
      expect(definition?.parameters?.properties).toBeTypeOf('object')
      expect(Array.isArray(definition?.parameters?.required)).toBe(true)
      expect('execute' in (definition ?? {})).toBe(false)
      expect(definition?.approvalRequired).toBe(false)
    }
    expect(registry.list().map(tool => tool.name).sort()).toEqual(names.sort())
  })

  it('reads parameter windows without any write side effect', () => {
    const { registry, store } = harness()
    seedParameter(store)
    const telemetryBefore = store.telemetry(RUN, 500).length
    const deviationsBefore = store.deviations(RUN).length

    const single = run<{ parameter: Record<string, unknown> }>(registry, 'industrial_parameter_list', { key: 'TEMP' })
    expect(single.parameter).toMatchObject({
      key: 'TEMP', unit: '°C', target: 25, lowerLimit: 20, upperLimit: 30, classification: 'CPP',
    })
    const listed = run<{ parameters: unknown[] }>(registry, 'industrial_parameter_list', {})
    expect(listed.parameters).toHaveLength(1)

    expect(store.telemetry(RUN, 500)).toHaveLength(telemetryBefore)
    expect(store.deviations(RUN)).toHaveLength(deviationsBefore)
    expect(store.parameters(RUN)).toHaveLength(1)
  })

  it('rejects an unknown parameter key on read without writing', () => {
    const { registry, store } = harness()
    seedParameter(store)
    expect(() => run(registry, 'industrial_parameter_list', { key: 'MISSING' })).toThrow('参数不存在')
    expect(store.telemetry(RUN, 500)).toHaveLength(0)
    expect(store.deviations(RUN)).toHaveLength(0)
  })

  it('records an in-window measurement and keeps the original value and unit', () => {
    const { registry, store } = harness()
    seedParameter(store)
    const result = run<{
      point: Record<string, unknown>
      deviation: unknown
      deviationOpened: boolean
    }>(registry, 'industrial_telemetry_record', { parameterKey: 'TEMP', value: 24.5, unit: '°C', reason: '操作员读数' })

    expect(result.point).toMatchObject({ parameterKey: 'TEMP', value: 24.5, unit: '°C', quality: 'GOOD' })
    expect(result.deviationOpened).toBe(false)
    expect(result.deviation).toBeNull()

    const stored = store.telemetry(RUN, 10)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ value: 24.5, unit: '°C' })
  })

  it('preserves negative and fractional values verbatim', () => {
    const { registry, store } = harness()
    seedParameter(store, { key: 'PH', name: 'pH', unit: 'pH', lowerLimit: 6, upperLimit: 8, target: 7 })
    run(registry, 'industrial_telemetry_record', { parameterKey: 'PH', value: -3.25, unit: 'pH' })
    const stored = store.telemetry(RUN, 10)
    expect(stored[0]?.value).toBe(-3.25)
    expect(stored[0]?.unit).toBe('pH')
  })

  it('opens an automatic deviation outside the window and updates it instead of stacking', () => {
    const { registry, store } = harness()
    seedParameter(store)

    const first = run<{ deviation: Record<string, unknown> }>(
      registry, 'industrial_telemetry_record', { parameterKey: 'TEMP', value: 34, unit: '°C' },
    )
    expect(first.deviation).toMatchObject({
      source: 'AUTO_LIMIT', status: 'OPEN', severity: 'HIGH', parameterKey: 'TEMP',
      observedValue: 34, lowerLimit: 20, upperLimit: 30,
    })
    const firstId = first.deviation.id

    const second = run<{ deviation: Record<string, unknown> }>(
      registry, 'industrial_telemetry_record', { parameterKey: 'TEMP', value: 35, unit: '°C' },
    )
    expect(second.deviation.id).toBe(firstId)
    expect(second.deviation.observedValue).toBe(35)

    const listed = run<{ items: unknown[] }>(registry, 'industrial_deviation_list', { status: 'OPEN' })
    expect(listed.items).toHaveLength(1)
    const points = store.telemetry(RUN, 10)
    expect(points.map(point => point.value).sort()).toEqual([34, 35])
  })

  it('rejects a unit that contradicts the parameter definition and writes nothing', () => {
    const { registry, store } = harness()
    seedParameter(store)
    expect(() => run(registry, 'industrial_telemetry_record', { parameterKey: 'TEMP', value: 24, unit: 'K' }))
      .toThrow('不一致')
    expect(store.telemetry(RUN, 10)).toHaveLength(0)
    expect(store.deviations(RUN)).toHaveLength(0)
  })

  it('requires an explicit unit when the parameter declares none', () => {
    const { registry, store } = harness()
    seedParameter(store, { key: 'OD', name: 'OD600', unit: '', classification: 'PROCESS', lowerLimit: 0, upperLimit: 10 })
    expect(() => run(registry, 'industrial_telemetry_record', { parameterKey: 'OD', value: 5 }))
      .toThrow('必须明确提供单位')
    expect(store.telemetry(RUN, 10)).toHaveLength(0)

    const recorded = run<{ point: Record<string, unknown> }>(
      registry, 'industrial_telemetry_record', { parameterKey: 'OD', value: 5, unit: 'AU' },
    )
    expect(recorded.point).toMatchObject({ value: 5, unit: 'AU' })
    expect(store.telemetry(RUN, 10)).toHaveLength(1)
  })

  it('rejects missing or non-finite measurement values instead of defaulting', () => {
    const { registry, store } = harness()
    seedParameter(store)
    const badValues: unknown[] = [undefined, null, '', 'abc', Number.NaN, Number.POSITIVE_INFINITY, true, {}]
    for (const value of badValues) {
      expect(() => run(registry, 'industrial_telemetry_record', { parameterKey: 'TEMP', value, unit: '°C' }))
        .toThrow()
    }
    expect(store.telemetry(RUN, 10)).toHaveLength(0)
    expect(store.deviations(RUN)).toHaveLength(0)
  })

  it('rejects an unknown workflow run before touching the store', () => {
    const { registry, store } = harness()
    seedParameter(store)
    expect(() => run(registry, 'industrial_telemetry_list', { runId: 'missing-run' })).toThrow('工作流运行不存在。')
    expect(() => run(registry, 'industrial_telemetry_record', {
      runId: 'missing-run', parameterKey: 'TEMP', value: 24, unit: '°C',
    })).toThrow('工作流运行不存在。')
    expect(store.telemetry(RUN, 10)).toHaveLength(0)
  })

  it('leaves no record when a write is not backed by explicitly valid input', () => {
    const { registry, store } = harness()
    seedParameter(store)
    const unauthorized: Array<() => unknown> = [
      () => run(registry, 'industrial_telemetry_record', { parameterKey: 'TEMP', unit: '°C' }),
      () => run(registry, 'industrial_telemetry_record', { value: 24, unit: '°C' }),
      () => run(registry, 'industrial_telemetry_record', { parameterKey: 'UNKNOWN', value: 24, unit: '°C' }),
      () => run(registry, 'industrial_deviation_create', { description: '缺少标题' }),
      () => run(registry, 'industrial_deviation_create', { title: '坏偏差', parameterKey: 'UNKNOWN' }),
    ]
    for (const attempt of unauthorized) expect(attempt).toThrow()
    expect(store.telemetry(RUN, 10)).toHaveLength(0)
    expect(store.deviations(RUN)).toHaveLength(0)
    expect(store.parameters(RUN)).toHaveLength(1)
  })

  it('refuses a measurement whose value is only present in injected context, not the user message', () => {
    const { registry, store } = harness()
    seedParameter(store)
    const evidenceOnly: Array<[Record<string, unknown>, string]> = [
      [{ parameterKey: 'TEMP', value: 34, unit: '°C' }, 'What does the document say about TEMP?'],
      [{ parameterKey: 'TEMP', value: 34, unit: '°C' }, 'record the observation from the attached file'],
      [{ parameterKey: 'TEMP', value: 34, unit: '°C' }, 'record TEMP for this run'],
    ]
    for (const [input, userMessage] of evidenceOnly) {
      expect(() => run(registry, 'industrial_telemetry_record', input, { userMessage })).toThrow(/拒绝|未明确|未出现/)
    }
    // No user turn at all is also a refusal (fail closed).
    expect(() => run(registry, 'industrial_telemetry_record', { parameterKey: 'TEMP', value: 34, unit: '°C' }, { userMessage: '' }))
      .toThrow('拒绝')
    expect(store.telemetry(RUN, 10)).toHaveLength(0)
    expect(store.deviations(RUN)).toHaveLength(0)
  })

  it('authorizes a measurement that the user explicitly requested with the value in their own words', () => {
    const { registry, store } = harness()
    seedParameter(store)
    const result = run<{ point: Record<string, unknown>; deviation: Record<string, unknown> | null }>(
      registry, 'industrial_telemetry_record',
      { parameterKey: 'TEMP', value: 34, unit: '°C' },
      { userMessage: 'Please record TEMP = 34 °C for this run and tell me what happens next.' },
    )
    expect(result.point).toMatchObject({ parameterKey: 'TEMP', value: 34, unit: '°C' })
    expect(result.deviation).toMatchObject({ source: 'AUTO_LIMIT', observedValue: 34, upperLimit: 30 })
    expect(store.telemetry(RUN, 10)).toHaveLength(1)
  })

  it('refuses a deviation whose title and observed value are not in the user message', () => {
    const { registry, store } = harness()
    seedParameter(store)
    expect(() => run(registry, 'industrial_deviation_create',
      { title: 'Arbitrary drift', parameterKey: 'TEMP', observedValue: 31 },
      { userMessage: 'Record TEMP = 31 °C for this run.' }))
      .toThrow('未在用户本轮消息中出现')
    expect(store.deviations(RUN)).toHaveLength(0)
    const created = run<{ deviation: Record<string, unknown> }>(registry, 'industrial_deviation_create',
      { title: 'TEMP drift', parameterKey: 'TEMP', observedValue: 31 },
      { userMessage: 'Record a TEMP drift deviation with observed value 31.' })
    expect(created.deviation).toMatchObject({ source: 'MANUAL', parameterKey: 'TEMP', observedValue: 31 })
  })

  it('keeps normal out-of-window records but refuses an implausible magnitude', () => {
    const { registry, store } = harness()
    seedParameter(store)
    const normal = run<{ deviation: Record<string, unknown> }>(
      registry, 'industrial_telemetry_record',
      { parameterKey: 'TEMP', value: 250, unit: '°C' },
      { userMessage: 'record TEMP 250 °C' },
    )
    expect(normal.deviation).toMatchObject({ source: 'AUTO_LIMIT', observedValue: 250 })

    const absurd = '1000000000000000000000'
    expect(() => run(registry, 'industrial_telemetry_record',
      { parameterKey: 'TEMP', value: Number(absurd), unit: '°C' },
      { userMessage: `record TEMP ${absurd} °C` }))
      .toThrow('可解释量级上限')
    expect(store.telemetry(RUN, 10)).toHaveLength(1)
  })

  it('rejects unit garbage when the parameter declares no unit of its own', () => {
    const { registry, store } = harness()
    seedParameter(store, { key: 'OD', name: 'OD600', unit: '', classification: 'PROCESS', lowerLimit: 0, upperLimit: 10 })
    expect(() => run(registry, 'industrial_telemetry_record',
      { parameterKey: 'OD', value: 5, unit: '%%' },
      { userMessage: 'record OD 5 %%' }))
      .toThrow('不是可识别的单位写法')
    expect(store.telemetry(RUN, 10)).toHaveLength(0)
  })

  it('lists and creates manual deviations through the store', () => {
    const { registry, store } = harness()
    seedParameter(store)

    const created = run<{ deviation: Record<string, unknown> }>(registry, 'industrial_deviation_create', {
      title: '人工复核偏差', parameterKey: 'TEMP', observedValue: 31, severity: 'MEDIUM', description: '操作员复核',
    })
    expect(created.deviation).toMatchObject({
      source: 'MANUAL', status: 'OPEN', severity: 'MEDIUM', parameterKey: 'TEMP', observedValue: 31,
    })

    expect(run<{ items: unknown[] }>(registry, 'industrial_deviation_list', {}).items).toHaveLength(1)
    expect(run<{ items: unknown[] }>(registry, 'industrial_deviation_list', { status: 'OPEN' }).items).toHaveLength(1)
    expect(run<{ items: unknown[] }>(registry, 'industrial_deviation_list', { status: 'RESOLVED' }).items).toHaveLength(0)
    expect(() => run(registry, 'industrial_deviation_list', { status: 'NOPE' })).toThrow('必须是以下之一')

    expect(() => run(registry, 'industrial_deviation_create', { title: '坏偏差', parameterKey: 'MISSING' }))
      .toThrow('参数不存在')
    expect(() => run(registry, 'industrial_deviation_create', {})).toThrow('title 不能为空')
    expect(store.deviations(RUN)).toHaveLength(1)
  })

  it('keeps read-only tools free of write side effects on telemetry, deviations and parameters', () => {
    const { registry, store } = harness()
    seedParameter(store)
    run(registry, 'industrial_telemetry_record', { parameterKey: 'TEMP', value: 34, unit: '°C' })

    const snapshot = () => JSON.stringify({
      parameters: store.parameters(RUN),
      telemetry: store.telemetry(RUN, 500),
      deviations: store.deviations(RUN),
    })
    const before = snapshot()
    run(registry, 'industrial_parameter_list', {})
    run(registry, 'industrial_telemetry_list', {})
    run(registry, 'industrial_deviation_list', {})
    expect(snapshot()).toBe(before)
  })

  it('invokes the registerTools hook with the agent registry', async () => {
    const dir = workingDir('wetflow-industrial-context-')
    const industrial = new IndustrialStore(join(dir, 'industrial.db'))
    industrialStores.push(industrial)
    let captured: ToolRegistry | undefined
    const ctx = await createWetFlowContext({
      dbPath: join(dir, 'wetflow.db'),
      registerTools: registry => {
        captured = registry
        registerIndustrialTools(registry, {
          store: () => industrial,
          resolveRunId: candidate => candidate?.trim() || 'run-context',
          actor: ACTOR,
        })
      },
    })
    try {
      expect(captured).toBeDefined()
      expect(captured?.get('workflow_status')?.name).toBe('workflow_status')
      expect(captured?.get('industrial_parameter_list')?.name).toBe('industrial_parameter_list')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('preserves the existing workflow approval boundary and schema fallback', () => {
    const dir = workingDir('wetflow-industrial-boundary-')
    const workflow = new WetFlowStore(join(dir, 'wetflow.db'))
    workflowStores.push(workflow)
    const industrial = new IndustrialStore(join(dir, 'industrial.db'))
    industrialStores.push(industrial)

    const registry = createWetFlowTools(workflow)
    registerIndustrialTools(registry, {
      store: () => industrial,
      resolveRunId: candidate => candidate?.trim() || workflow.activeWorkflowRunId(),
      actor: ACTOR,
    })

    expect(registry.get('workflow_advance').approvalRequired).toBe(true)
    expect(registry.get('workflow_pause').approvalRequired).toBe(true)
    expect(registry.get('workflow_status').approvalRequired).toBe(false)
    expect(registry.get('industrial_telemetry_record').approvalRequired).toBe(false)

    const definitions = registry.definitions()
    expect(definitions).toHaveLength(9)
    const advance = definitions.find(item => item.name === 'workflow_advance')
    expect(advance && 'parameters' in advance).toBe(false)
    expect(definitions.find(item => item.name === 'industrial_telemetry_record')?.parameters)
      .toMatchObject({ type: 'object' })
  })
})
