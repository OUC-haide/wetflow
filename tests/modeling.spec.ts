import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelingService, type ModelingServiceOptions } from '../src/modeling/service.js'

const RUN_ID = 'run-1'
const MONOD_VERSION = 'monod-conservative-rk4-2'
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])

function detectPython(): string | undefined {
  for (const candidate of [process.env.PYTHON_EXECUTABLE, 'python3', 'python']) {
    if (!candidate) continue
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version)'], { stdio: 'ignore' })
    if (probe.status === 0) return candidate
  }
  return undefined
}
const PYTHON = detectPython()
/** Worker-backed tests are only meaningful with a real Python interpreter present. */
const workerIt = PYTHON ? it : it.skip

const dirs: string[] = []
const services: ModelingService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) {
    try { await service.close() } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface PredictionCall { runId: string; input: Record<string, unknown> }
interface LinkCall { runId: string; predictionId: string; experimentRef: string; note: string }

function makeService(overrides: Partial<ModelingServiceOptions> = {}): {
  dir: string
  service: ModelingService
  predictionCalls: PredictionCall[]
  linkCalls: LinkCall[]
} {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-'))
  dirs.push(dir)
  const predictionCalls: PredictionCall[] = []
  const linkCalls: LinkCall[] = []
  const service = new ModelingService({
    dataDir: join(dir, 'modeling'),
    validateRunId: runId => { if (runId !== RUN_ID) throw new Error('unknown run') },
    createPrediction: (runId, input) => {
      predictionCalls.push({ runId, input })
      return { id: `prediction-${predictionCalls.length}` }
    },
    linkPrediction: (runId, predictionId, experimentRef, note) => {
      linkCalls.push({ runId, predictionId, experimentRef, note })
    },
    ...(PYTHON ? { pythonExecutable: PYTHON } : {}),
    ...overrides,
  })
  services.push(service)
  return { dir, service, predictionCalls, linkCalls }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitTerminal(service: ModelingService, taskId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = service.get(RUN_ID, taskId)
    if (TERMINAL.has(task.status)) return task
    if (Date.now() > deadline) throw new Error(`task did not finish: ${task.status} ${task.error ?? ''}`)
    await sleep(15)
  }
}
async function waitStatus(service: ModelingService, taskId: string, status: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = service.get(RUN_ID, taskId)
    if (task.status === status) return task
    if (TERMINAL.has(task.status)) throw new Error(`waiting for ${status} but reached ${task.status}: ${task.error ?? ''}`)
    if (Date.now() > deadline) throw new Error(`task did not reach ${status}: ${task.status}`)
    await sleep(10)
  }
}

const monod = (overrides: Record<string, number> = {}) => ({
  initialBiomass: 0.1, initialSubstrate: 1, muMax: 1, halfSaturation: 0.1,
  yield: 0.5, duration: 4, timeStep: 0.1, ...overrides,
})

describe('modeling numerics and datasets', () => {
  it('exposes both methods with fixed units, versions and the enforced limits', () => {
    const { service } = makeService()
    const methods = service.methods()
    expect(methods.items.map(item => item.id)).toEqual(['monod_batch', 'growth_fit'])
    const monod = methods.items[0]!
    expect(monod.version).toBe(MONOD_VERSION)
    expect(monod.units).toEqual({ time: 'h', biomass: 'g/L', substrate: 'g/L' })
    const properties = monod.inputSchema.properties as Record<string, { unit?: string }>
    expect(properties.timeStep?.unit).toBe('h')
    expect(properties.muMax?.unit).toBe('1/h')
    expect(methods.limits).toEqual({
      defaultWallTimeMs: 30_000, maxWallTimeMs: 120_000,
      defaultMaxOutputRows: 5_000, maxOutputRows: 20_001,
      maxCsvBytes: 2_000_000, maxCsvRows: 20_000, maxExperimentNote: 600,
    })
  })

  workerIt('conserves X + Y*S and never fabricates biomass on the coarse-step depletion example', async () => {
    const { service } = makeService()
    const submitted = service.submit(RUN_ID, {
      method: 'monod_batch',
      parameters: { initialBiomass: 1, initialSubstrate: 0.1, muMax: 10, halfSaturation: 0.1, yield: 0.5, duration: 1, timeStep: 1 },
    })
    const task = await waitTerminal(service, submitted.id)
    expect(task.status, task.error).toBe('SUCCEEDED')
    expect(task.methodVersion).toBe(MONOD_VERSION)

    const result = service.result(RUN_ID, task.id)
    expect(result.methodVersion).toBe(MONOD_VERSION)
    const pool = 1 + 0.5 * 0.1
    expect(result.summary.maxBiomass).toBeLessThanOrEqual(1.05 + 1e-9)
    expect(result.summary.finalBiomass).toBeCloseTo(1.05, 9)
    expect(result.metrics.biomassIncrease).toBeCloseTo(0.05, 9)
    expect(result.metrics.substrateConsumed).toBeCloseTo(0.1, 9)
    expect(result.metrics.conservationResidual).toBeCloseTo(0, 9)
    // Every displayed metric carries an explicit unit.
    for (const metric of Object.keys(result.metrics)) {
      expect(result.units[metric], `unit for ${metric}`).toBeTruthy()
    }

    const csv = readFileSync(service.artifact(RUN_ID, task.id, 'trajectory').path, 'utf8')
    const lines = csv.trim().split(/\r?\n/)
    expect(lines[0]).toBe('time_h,biomass_g_L,substrate_g_L')
    const rows = lines.slice(1).map(line => line.split(',').map(Number))
    expect(rows).toHaveLength(2)
    for (const [time, biomass, substrate] of rows as Array<[number, number, number]>) {
      expect(Number.isFinite(time) && Number.isFinite(biomass) && Number.isFinite(substrate)).toBe(true)
      expect(biomass).toBeGreaterThanOrEqual(0)
      expect(substrate).toBeGreaterThanOrEqual(0)
      expect(Math.abs((biomass - 1) + 0.5 * (substrate - 0.1))).toBeLessThan(1e-9 * Math.max(1, pool))
    }
  })

  workerIt('agrees between coarse and fine output steps for the same dynamics', async () => {
    const { service } = makeService()
    const coarse = service.submit(RUN_ID, { method: 'monod_batch', parameters: monod({ duration: 10, timeStep: 10 }) })
    const fine = service.submit(RUN_ID, { method: 'monod_batch', parameters: monod({ duration: 10, timeStep: 0.01 }) })
    const coarseTask = await waitTerminal(service, coarse.id)
    const fineTask = await waitTerminal(service, fine.id)
    expect(coarseTask.status, coarseTask.error).toBe('SUCCEEDED')
    expect(fineTask.status, fineTask.error).toBe('SUCCEEDED')
    const coarseResult = service.result(RUN_ID, coarseTask.id)
    const fineResult = service.result(RUN_ID, fineTask.id)
    // The substrate pool is fully consumed either way; the adaptive internal solver
    // must not depend on the output cadence.
    expect(coarseResult.summary.finalBiomass).toBeCloseTo(Number(fineResult.summary.finalBiomass), 6)
    expect(coarseResult.metrics.substrateConsumed).toBeCloseTo(Number(fineResult.metrics.substrateConsumed), 6)
    expect(coarseResult.summary.finalBiomass).toBeCloseTo(0.6, 6)
  })

  workerIt('treats exact zero substrate as no growth and non-negative mass balance', async () => {
    const { service } = makeService()
    const submitted = service.submit(RUN_ID, { method: 'monod_batch', parameters: monod({ initialSubstrate: 0, duration: 2, timeStep: 0.5 }) })
    const task = await waitTerminal(service, submitted.id)
    expect(task.status, task.error).toBe('SUCCEEDED')
    const result = service.result(RUN_ID, task.id)
    expect(result.summary.finalBiomass).toBeCloseTo(0.1, 12)
    expect(result.metrics.biomassIncrease).toBeCloseTo(0, 12)
    expect(result.metrics.substrateConsumed).toBeCloseTo(0, 12)
  })

  workerIt('recovers a known exponential curve and labels diagnostics without uncertainty claims', async () => {
    const { service } = makeService()
    const dataset = service.createDataset(RUN_ID, { name: 'growth', csv: 'time,biomass\n0,1\n1,2\n2,4\n3,8' })
    const submitted = service.submit(RUN_ID, { method: 'growth_fit', parameters: {}, datasetId: dataset.id })
    const task = await waitTerminal(service, submitted.id)
    expect(task.status, task.error).toBe('SUCCEEDED')
    const result = service.result(RUN_ID, task.id)
    expect(result.metrics.growthRate).toBeCloseTo(Math.log(2), 6)
    expect(result.metrics.doublingTime).toBeCloseTo(1, 6)
    expect(result.units.growthRate).toBe('1/h')
    expect(result.units.doublingTime).toBe('h')
    expect(result.diagnostics?.rSquared).toBeCloseTo(1, 6)
    expect(result.uncertaintyNote).toMatch(/no uncertainty interval/i)
    const fitted = readFileSync(service.artifact(RUN_ID, task.id, 'trajectory').path, 'utf8')
    expect(fitted).toContain('observed_biomass_g_L,fitted_biomass_g_L,log_residual')
  })

  workerIt('handles constant and declining series without inventing a doubling time', async () => {
    const { service } = makeService()
    const constant = service.createDataset(RUN_ID, { name: 'constant', csv: 'time,biomass\n0,2\n1,2\n2,2' })
    const declining = service.createDataset(RUN_ID, { name: 'declining', csv: 'time,biomass\n0,8\n1,4\n2,2' })
    const constantTask = await waitTerminal(service, service.submit(RUN_ID, { method: 'growth_fit', parameters: {}, datasetId: constant.id }).id)
    const decliningTask = await waitTerminal(service, service.submit(RUN_ID, { method: 'growth_fit', parameters: {}, datasetId: declining.id }).id)
    expect(constantTask.status, constantTask.error).toBe('SUCCEEDED')
    expect(decliningTask.status, decliningTask.error).toBe('SUCCEEDED')
    const constantResult = service.result(RUN_ID, constantTask.id)
    expect(constantResult.metrics.growthRate).toBeCloseTo(0, 12)
    expect(constantResult.metrics.doublingTime).toBeUndefined()
    // Zero variance means R^2 is undefined; it must not be reported as a perfect fit.
    expect(constantResult.diagnostics?.rSquared).toBeUndefined()
    const decliningResult = service.result(RUN_ID, decliningTask.id)
    expect(decliningResult.metrics.growthRate).toBeLessThan(0)
    expect(decliningResult.metrics.doublingTime).toBeUndefined()
  })

  it('rejects blank, non-finite, non-monotonic and non-positive CSV cells before storing a dataset', () => {
    const { service } = makeService()
    expect(() => service.createDataset(RUN_ID, { name: 'blank', csv: 'time,biomass\n0,\n1,2' })).toThrow(/blank/)
    expect(() => service.createDataset(RUN_ID, { name: 'nan', csv: 'time,biomass\n0,NaN\n1,2' })).toThrow(/finite/)
    expect(() => service.createDataset(RUN_ID, { name: 'inf', csv: 'time,biomass\n0,1\nInfinity,2' })).toThrow(/finite/)
    expect(() => service.createDataset(RUN_ID, { name: 'flat', csv: 'time,biomass\n0,1\n0,2' })).toThrow(/increase/)
    expect(() => service.createDataset(RUN_ID, { name: 'negative', csv: 'time,biomass\n0,-1\n1,2' })).toThrow(/positive/)
    expect(() => service.createDataset(RUN_ID, { name: 'missing', csv: 't,x\n0,1\n1,2' })).toThrow(/time/)
    expect(() => service.createDataset(RUN_ID, { name: 'wide', csv: `time,biomass,${'x,'.repeat(60)}y\n0,1,${'0,'.repeat(60)}0` })).toThrow()
  })

  it('rejects invalid parameters, unknown fields, bad budgets and short growth datasets before queueing', () => {
    const { service } = makeService()
    const submit = (input: Parameters<ModelingService['submit']>[1]) => service.submit(RUN_ID, input)
    expect(() => submit({ method: 'unknown', parameters: {} })).toThrow(/Unknown modeling method/)
    expect(() => submit({ method: 'monod_batch', parameters: monod({ muMax: -1 }) })).toThrow()
    expect(() => submit({ method: 'monod_batch', parameters: monod({ muMax: 1e9 }) })).toThrow(/exceed/)
    expect(() => submit({ method: 'monod_batch', parameters: monod({ initialBiomass: Number.POSITIVE_INFINITY }) })).toThrow(/finite/)
    expect(() => submit({ method: 'monod_batch', parameters: monod({ timeStep: 100 }) })).toThrow(/timeStep/)
    expect(() => submit({ method: 'monod_batch', parameters: { ...monod(), extra: 1 } })).toThrow(/unknown parameter/)
    expect(() => submit({ method: 'monod_batch', parameters: { ...monod(), muMax: undefined } as unknown as Record<string, number> })).toThrow(/finite/)
    expect(() => submit({ method: 'monod_batch', parameters: monod(), datasetId: 'whatever' })).toThrow(/does not accept a datasetId/)
    expect(() => submit({ method: 'monod_batch', parameters: monod(), budget: { wallTimeMs: 50 } })).toThrow(/wallTimeMs/)
    expect(() => submit({ method: 'monod_batch', parameters: monod(), budget: { maxOutputRows: 1 } })).toThrow(/maxOutputRows/)
    expect(() => submit({ method: 'monod_batch', parameters: monod(), budget: { surprise: 1 } as never })).toThrow(/unknown field/)
    expect(() => submit({ method: 'growth_fit', parameters: {} })).toThrow(/datasetId/)
    expect(() => submit({ method: 'growth_fit', parameters: { x: 1 }, datasetId: 'd' })).toThrow(/does not accept parameters/)

    const short = service.createDataset(RUN_ID, { name: 'short', csv: 'time,biomass\n0,1\n1,2' })
    expect(() => submit({ method: 'growth_fit', parameters: {}, datasetId: short.id })).toThrow(/at least 3/)
    expect(() => submit({ method: 'growth_fit', parameters: {}, datasetId: 'missing-dataset' })).toThrow(/not found/)
    // No rejected submit left a phantom job behind.
    expect(service.list(RUN_ID)).toHaveLength(0)
  })

  workerIt('accepts a null budget as the documented default', async () => {
    const { service } = makeService()
    const payload = { method: 'monod_batch', parameters: monod({ duration: 1, timeStep: 1 }), budget: null } as unknown as Parameters<ModelingService['submit']>[1]
    const task = service.submit(RUN_ID, payload)
    const finished = await waitTerminal(service, task.id)
    expect(finished.status, finished.error).toBe('SUCCEEDED')
  })

  workerIt('exposes both a numerical CSV and a real result.json artifact and scopes every lookup', async () => {
    const { service } = makeService()
    const task = await waitTerminal(service, service.submit(RUN_ID, { method: 'monod_batch', parameters: monod({ duration: 1, timeStep: 1 }) }).id)
    expect(task.status, task.error).toBe('SUCCEEDED')
    const result = service.result(RUN_ID, task.id)
    expect(result.artifacts.map(artifact => artifact.id)).toEqual(['trajectory', 'result'])
    expect(service.artifact(RUN_ID, task.id, 'trajectory').name).toBe('output.csv')
    const resultArtifact = service.artifact(RUN_ID, task.id, 'result')
    expect(resultArtifact.name).toBe('result.json')
    expect(resultArtifact.mediaType).toBe('application/json')
    const onDisk = JSON.parse(readFileSync(resultArtifact.path, 'utf8')) as { method: string; methodVersion: string }
    expect(onDisk.method).toBe('monod_batch')
    expect(onDisk.methodVersion).toBe(MONOD_VERSION)

    expect(() => service.artifact(RUN_ID, task.id, '../result')).toThrow(/unavailable/)
    expect(() => service.artifact(RUN_ID, task.id, 'trajectory/../result')).toThrow(/unavailable/)
    expect(() => service.get(RUN_ID, '../escape')).toThrow(/Invalid owned identifier/)
    expect(() => service.get('run-2', task.id)).toThrow(/unknown run/)
    expect(() => service.result('run-2', task.id)).toThrow(/unknown run/)
  })

  workerIt('persists a successful task and its artifacts across a service restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-'))
    dirs.push(dir)
    const options: ModelingServiceOptions = {
      dataDir: join(dir, 'modeling'),
      validateRunId: runId => { if (runId !== RUN_ID) throw new Error('unknown run') },
      createPrediction: () => ({ id: 'unused' }),
      ...(PYTHON ? { pythonExecutable: PYTHON } : {}),
    }
    const first = new ModelingService(options)
    const task = await waitTerminal(first, first.submit(RUN_ID, { method: 'monod_batch', parameters: monod({ duration: 2, timeStep: 0.5 }) }).id)
    expect(task.status, task.error).toBe('SUCCEEDED')
    await first.close()

    const second = new ModelingService(options)
    services.push(second)
    const recovered = second.get(RUN_ID, task.id)
    expect(recovered.status).toBe('SUCCEEDED')
    expect(recovered.methodVersion).toBe(MONOD_VERSION)
    const result = second.result(RUN_ID, task.id)
    expect(result.metrics.biomassIncrease).toBeGreaterThan(0)
    expect(result.methodVersion).toBe(MONOD_VERSION)
    // The downloadable result artifact still resolves after restart.
    expect(second.artifact(RUN_ID, task.id, 'result').name).toBe('result.json')
  })

  workerIt('registers one idempotent prediction bound to the job-derived method version and result reference', async () => {
    const { service, predictionCalls, linkCalls } = makeService()
    const task = await waitTerminal(service, service.submit(RUN_ID, { method: 'monod_batch', parameters: monod({ duration: 1, timeStep: 1 }) }).id)
    expect(task.status, task.error).toBe('SUCCEEDED')

    const first = service.registerPrediction(RUN_ID, task.id, { prediction: 'Final biomass is 0.6 g/L' })
    expect(first.predictionId).toBe('prediction-1')
    expect(first.task.predictionId).toBe('prediction-1')
    expect(predictionCalls).toHaveLength(1)
    expect(String(predictionCalls[0]!.input.model)).toBe(`monod_batch v${MONOD_VERSION}`)
    expect(String(predictionCalls[0]!.input.artifactRef)).toContain(`/api/modeling/tasks/${task.id}/artifacts/result?runId=${RUN_ID}`)

    // Registering again is idempotent: no second prediction record is created.
    const second = service.registerPrediction(RUN_ID, task.id, { prediction: 'A different wording' })
    expect(second.predictionId).toBe('prediction-1')
    expect(predictionCalls).toHaveLength(1)

    const linked = service.linkExperiment(RUN_ID, task.id, { experimentRef: 'ELN-2026-42', note: 'follow-up measurement' })
    expect(linked.linkedExperiment).toBe('ELN-2026-42')
    expect(linked.linkedExperimentNote).toBe('follow-up measurement')
    expect(linkCalls).toEqual([{ runId: RUN_ID, predictionId: 'prediction-1', experimentRef: 'ELN-2026-42', note: 'follow-up measurement' }])
    // Linking is a reference only; it never mutates evidence status.
    expect(service.get(RUN_ID, task.id).status).toBe('SUCCEEDED')

    expect(() => service.linkExperiment(RUN_ID, task.id, { experimentRef: 'ELN-OTHER' })).toThrow(/different experiment/)
    expect(() => service.registerPrediction(RUN_ID, 'missing-task', { prediction: 'x' })).toThrow(/not found/)
  })

  workerIt('rejects misleading prediction payloads without calling the prediction store', async () => {
    const { service, predictionCalls } = makeService()
    expect(() => service.registerPrediction(RUN_ID, 'missing', { prediction: 'aa' })).toThrow(/not found/)
    const success = await waitTerminal(service, service.submit(RUN_ID, { method: 'monod_batch', parameters: monod({ duration: 1, timeStep: 1 }) }).id)
    expect(success.status, success.error).toBe('SUCCEEDED')
    expect(() => service.registerPrediction(RUN_ID, success.id, { prediction: '' })).toThrow(/prediction/)
    expect(() => service.registerPrediction(RUN_ID, success.id, { prediction: 'ok', conditions: 'x'.repeat(600) })).toThrow(/conditions/)
    expect(() => service.registerPrediction(RUN_ID, success.id, { prediction: 'ok', uncertainty: 'x'.repeat(600) })).toThrow(/uncertainty/)
    expect(() => service.registerPrediction(RUN_ID, success.id, { prediction: 'ok', linkedExperiment: 'x'.repeat(501) })).toThrow(/linkedExperiment/)
    expect(predictionCalls).toHaveLength(0)
  })
})
