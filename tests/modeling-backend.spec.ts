import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelingService, type ModelingServiceOptions } from '../src/modeling/service.js'

const RUN_ID = 'run-1'
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])
const REAL_WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '../src/modeling/worker.py')

function detectPython(): string | undefined {
  for (const candidate of [process.env.PYTHON_EXECUTABLE, 'python3', 'python']) {
    if (!candidate) continue
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version)'], { stdio: 'ignore' })
    if (probe.status === 0) return candidate
  }
  return undefined
}
const PYTHON = detectPython()
const workerIt = PYTHON ? it : it.skip
const posixIt = process.platform === 'win32' ? it.skip : it

const dirs: string[] = []
const services: ModelingService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) {
    try { await service.close() } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

function fixtureFile(source: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-fixture-'))
  dirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, source)
  return path
}

const SLEEP_SOURCE = 'import sys, time\ntime.sleep(30)\n'
const PARTIAL_SOURCE = [
  'import json, sys, time',
  'request = json.load(sys.stdin)',
  'with open(request["csvPath"], "w") as handle:',
  '    handle.write("time_h,biomass_g_L,substrate_g_L\\n0,1,1\\n")',
  'time.sleep(30)',
].join('\n')
const FAIL_SOURCE = [
  'import json, sys',
  'sys.stdin.read()',
  'sys.stdout.write(json.dumps({"error": "fixture forced failure"}))',
  'sys.exit(3)',
].join('\n')
const MALFORMED_SOURCE = 'import sys\nsys.stdin.read()\nsys.stdout.write("this is not json")\n'
const HUGE_SOURCE = [
  'import sys',
  'sys.stdin.read()',
  'for _ in range(4000):',
  '    sys.stdout.write("x" * 4096)',
].join('\n')
const MISSING_CSV_SOURCE = [
  'import json, sys',
  'sys.stdin.read()',
  'sys.stdout.write(json.dumps({',
  '    "method": "monod_batch",',
  '    "methodVersion": "monod-conservative-rk4-2",',
  '    "summary": {"outputRows": 2, "finalBiomass": 0.2},',
  '    "metrics": {"biomassIncrease": 0.1},',
  '    "units": {"biomassIncrease": "g/L"},',
  '    "assumptions": ["assumption"],',
  '    "limitations": ["limitation"],',
  '}))',
].join('\n')

/** Deterministic fixture: fails or sleeps for sentinel substrates, otherwise runs the real worker. */
function hybridSource(): string {
  return [
    'import io, json, sys, runpy, time',
    'raw = sys.stdin.read()',
    'request = json.loads(raw)',
    'substrate = request.get("parameters", {}).get("initialSubstrate")',
    'if substrate == 12345:',
    '    sys.stdout.write(json.dumps({"error": "fixture forced failure"}))',
    '    sys.exit(2)',
    'if substrate == 999:',
    '    time.sleep(30)',
    '    sys.exit(0)',
    'sys.stdin = io.StringIO(raw)',
    `runpy.run_path(${JSON.stringify(REAL_WORKER)}, run_name="__main__")`,
  ].join('\n')
}

const monod = (overrides: Record<string, number> = {}) => ({
  initialBiomass: 0.1, initialSubstrate: 1, muMax: 1, halfSaturation: 0.1,
  yield: 0.5, duration: 1, timeStep: 1, ...overrides,
})

function serviceOptions(dir: string, overrides: Partial<ModelingServiceOptions> = {}): ModelingServiceOptions {
  return {
    dataDir: join(dir, 'modeling'),
    validateRunId: runId => { if (runId !== RUN_ID) throw new Error('unknown run') },
    createPrediction: () => ({ id: 'prediction-backend' }),
    ...(PYTHON ? { pythonExecutable: PYTHON } : {}),
    ...overrides,
  }
}
function makeService(dir: string, overrides: Partial<ModelingServiceOptions> = {}): ModelingService {
  const service = new ModelingService(serviceOptions(dir, overrides))
  services.push(service)
  return service
}
function submit(service: ModelingService, parameters = monod(), budget = { wallTimeMs: 30_000, maxOutputRows: 5_000 }) {
  return service.submit(RUN_ID, { method: 'monod_batch', parameters, budget })
}
async function waitTerminal(service: ModelingService, taskId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = service.get(RUN_ID, taskId)
    if (TERMINAL.has(task.status)) return task
    if (Date.now() > deadline) throw new Error(`task did not finish: ${task.status} ${task.error ?? ''}`)
    await sleep(15)
  }
}
async function waitStatus(service: ModelingService, taskId: string, status: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = service.get(RUN_ID, taskId)
    if (task.status === status) return task
    if (TERMINAL.has(task.status)) throw new Error(`waiting for ${status} but reached ${task.status}: ${task.error ?? ''}`)
    if (Date.now() > deadline) throw new Error(`task did not reach ${status}: ${task.status}`)
    await sleep(10)
  }
}
function taskDir(dir: string, taskId: string): string {
  return join(dir, 'modeling', RUN_ID, 'tasks', taskId)
}

describe('modeling scheduler, worker lifecycle and owned paths', () => {
  workerIt('times out a hung worker, removes artifacts and frees the concurrency slot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-timeout-')); dirs.push(dir)
    const service = makeService(dir, { workerScript: fixtureFile(PARTIAL_SOURCE, 'partial.py'), concurrency: 1 })
    const first = submit(service, monod(), { wallTimeMs: 100, maxOutputRows: 100 })
    await waitStatus(service, first.id, 'RUNNING')
    const firstDone = await waitTerminal(service, first.id, 10_000)
    expect(firstDone.status).toBe('TIMED_OUT')
    expect(firstDone.error).toMatch(/wall time/)
    expect(existsSync(join(taskDir(dir, first.id), 'output.csv'))).toBe(false)
    expect(existsSync(join(taskDir(dir, first.id), 'result.json'))).toBe(false)

    const second = submit(service, monod(), { wallTimeMs: 100, maxOutputRows: 100 })
    const secondDone = await waitTerminal(service, second.id, 10_000)
    expect(secondDone.status).toBe('TIMED_OUT')
  })

  workerIt('cancels a running worker, removes partial artifacts and reports the cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-cancel-')); dirs.push(dir)
    const service = makeService(dir, { workerScript: fixtureFile(PARTIAL_SOURCE, 'partial.py'), concurrency: 1 })
    const task = submit(service)
    await waitStatus(service, task.id, 'RUNNING')
    const cancelled = service.cancel(RUN_ID, task.id)
    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.error).toMatch(/Cancelled by user/)
    await sleep(300)
    expect(existsSync(join(taskDir(dir, task.id), 'output.csv'))).toBe(false)
    expect(service.get(RUN_ID, task.id).status).toBe('CANCELLED')
  })

  workerIt('cancels a queued task and starts the next queued job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-queue-')); dirs.push(dir)
    const service = makeService(dir, { workerScript: fixtureFile(hybridSource(), 'hybrid.py'), concurrency: 1 })
    const slow = submit(service, monod({ initialSubstrate: 999 }))
    await waitStatus(service, slow.id, 'RUNNING')
    const next = submit(service, monod())
    expect(service.get(RUN_ID, next.id).status).toBe('QUEUED')
    service.cancel(RUN_ID, slow.id)
    const finished = await waitTerminal(service, next.id)
    expect(finished.status, finished.error).toBe('SUCCEEDED')
    expect(service.result(RUN_ID, next.id).metrics.biomassIncrease).toBeGreaterThan(0)
    expect(service.get(RUN_ID, slow.id).status).toBe('CANCELLED')
  })

  workerIt('isolates a failed worker and continues the queue with real numerical output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-isolate-')); dirs.push(dir)
    const service = makeService(dir, { workerScript: fixtureFile(hybridSource(), 'hybrid.py'), concurrency: 1 })
    const forced = submit(service, monod({ initialSubstrate: 12345 }))
    const failed = await waitTerminal(service, forced.id)
    expect(failed.status).toBe('FAILED')
    expect(failed.error).toMatch(/fixture forced failure/)

    const good = submit(service, monod())
    const succeeded = await waitTerminal(service, good.id)
    expect(succeeded.status, succeeded.error).toBe('SUCCEEDED')
    expect(service.result(RUN_ID, good.id).metrics.biomassIncrease).toBeGreaterThan(0)
  })

  workerIt('reports a missing interpreter and stays responsive for later submissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-nopython-')); dirs.push(dir)
    const service = makeService(dir, { pythonExecutable: join(dir, 'no-such-python-interpreter') })
    const first = submit(service)
    const firstDone = await waitTerminal(service, first.id)
    expect(firstDone.status).toBe('FAILED')
    expect(firstDone.error).toMatch(/Worker failed to start/)
    const second = submit(service)
    const secondDone = await waitTerminal(service, second.id)
    expect(secondDone.status).toBe('FAILED')
  })

  workerIt('reports a nonzero worker exit and a malformed worker response as failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-badout-')); dirs.push(dir)
    const failing = makeService(dir, { workerScript: fixtureFile(FAIL_SOURCE, 'fail.py') })
    const failedTask = submit(failing)
    const failed = await waitTerminal(failing, failedTask.id)
    expect(failed.status).toBe('FAILED')
    expect(failed.error).toMatch(/fixture forced failure/)

    const malformed = makeService(dir, { workerScript: fixtureFile(MALFORMED_SOURCE, 'malformed.py') })
    const malformedTask = submit(malformed)
    const malformedDone = await waitTerminal(malformed, malformedTask.id)
    expect(malformedDone.status).toBe('FAILED')
    expect(malformedDone.error).toMatch(/JSON|Unexpected/)
  })

  workerIt('bounds runaway worker stdout and fails the job instead of growing without limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-overflow-')); dirs.push(dir)
    const service = makeService(dir, { workerScript: fixtureFile(HUGE_SOURCE, 'huge.py') })
    const task = submit(service)
    const finished = await waitTerminal(service, task.id, 20_000)
    expect(finished.status).toBe('FAILED')
    expect(finished.error).toMatch(/more output/)
  })

  workerIt('fails a worker that returns a valid payload but never writes its CSV artifact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-nocsv-')); dirs.push(dir)
    const service = makeService(dir, { workerScript: fixtureFile(MISSING_CSV_SOURCE, 'nocsv.py') })
    const task = submit(service)
    const finished = await waitTerminal(service, task.id)
    expect(finished.status).toBe('FAILED')
    expect(finished.error).toMatch(/artifact is missing/)
  })

  workerIt('recovers RUNNING as interrupted, fails corrupt records and resumes valid QUEUED jobs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-recover-')); dirs.push(dir)
    const dataDir = join(dir, 'modeling')
    const tasksDir = join(dataDir, RUN_ID, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const base = {
      runId: RUN_ID, method: 'monod_batch', methodVersion: 'monod-conservative-rk4-2',
      parameters: monod(), budget: { wallTimeMs: 30_000, maxOutputRows: 5_000 },
      createdAt: new Date().toISOString(),
    }
    const write = (id: string, extra: Record<string, unknown>) => writeFileSync(join(tasksDir, `${id}.json`), JSON.stringify({ ...base, id, ...extra }))
    write('queued-ok', { title: 'queued', status: 'QUEUED' })
    write('running-stuck', { title: 'running', status: 'RUNNING' })
    write('invalid-params', { title: 'invalid', status: 'QUEUED', parameters: monod({ muMax: -1 }) })
    write('old-version', { title: 'old', status: 'QUEUED', methodVersion: 'legacy-1' })
    writeFileSync(join(tasksDir, 'garbage.json'), 'this is not json')

    const service = makeService(dir)
    expect(service.get(RUN_ID, 'running-stuck').status).toBe('FAILED')
    expect(service.get(RUN_ID, 'running-stuck').error).toMatch(/Interrupted by service restart/)
    expect(service.get(RUN_ID, 'invalid-params').status).toBe('FAILED')
    expect(service.get(RUN_ID, 'invalid-params').error).toMatch(/Persisted task is invalid/)
    expect(service.get(RUN_ID, 'old-version').status).toBe('FAILED')
    expect(service.get(RUN_ID, 'old-version').error).toMatch(/method version/)
    expect(service.list(RUN_ID).map(task => task.id)).not.toContain('garbage')

    const queued = await waitTerminal(service, 'queued-ok')
    expect(queued.status, queued.error).toBe('SUCCEEDED')
    expect(service.result(RUN_ID, 'queued-ok').metrics.biomassIncrease).toBeGreaterThan(0)
  })

  posixIt('never follows a symlinked tasks directory for reads, recovery or writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-symlink-')); dirs.push(dir)
    const dataDir = join(dir, 'modeling')
    mkdirSync(join(dataDir, RUN_ID), { recursive: true })
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(dataDir, RUN_ID, 'tasks'))
    const service = makeService(dir)
    expect(() => submit(service)).toThrow(/Symbolic link/)
  })

  posixIt('never follows a symlinked run directory during recovery or submit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-symlink-run-')); dirs.push(dir)
    const dataDir = join(dir, 'modeling')
    mkdirSync(dataDir, { recursive: true })
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(dataDir, RUN_ID))
    const service = makeService(dir)
    expect(() => submit(service)).toThrow(/Symbolic link/)
  })

  posixIt('rejects a symlinked dataset CSV instead of reading outside the data root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-symlink-csv-')); dirs.push(dir)
    const service = makeService(dir)
    const dataset = service.createDataset(RUN_ID, { name: 'growth', csv: 'time,biomass\n0,1\n1,2\n2,4' })
    await service.close()
    const csvPath = join(dir, 'modeling', RUN_ID, 'datasets', `${dataset.id}.csv`)
    const outsideFile = join(dir, 'outside.csv')
    writeFileSync(outsideFile, 'time,biomass\n0,1\n1,2\n2,4\n')
    unlinkSync(csvPath)
    symlinkSync(outsideFile, csvPath)
    const restarted = makeService(dir)
    expect(() => restarted.submit(RUN_ID, { method: 'growth_fit', parameters: {}, datasetId: dataset.id })).toThrow(/Symbolic link/)
  })

  posixIt('does not publish a task in memory when its record cannot be written to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-diskfail-')); dirs.push(dir)
    const service = makeService(dir)
    service.createDataset(RUN_ID, { name: 'growth', csv: 'time,biomass\n0,1\n1,2\n2,4' })
    const tasksDir = join(dir, 'modeling', RUN_ID, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    chmodSync(tasksDir, 0o500)
    try {
      expect(() => submit(service)).toThrow()
      expect(service.list(RUN_ID)).toHaveLength(0)
    } finally {
      chmodSync(tasksDir, 0o700)
    }
  })

  workerIt('never runs more jobs than the configured concurrency and rejects cross-run task ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-concurrency-')); dirs.push(dir)
    const service = makeService(dir, { workerScript: fixtureFile(SLEEP_SOURCE, 'sleep.py'), concurrency: 2 })
    const first = submit(service)
    const second = submit(service)
    const third = submit(service)
    await waitStatus(service, first.id, 'RUNNING')
    await waitStatus(service, second.id, 'RUNNING')
    expect(service.get(RUN_ID, third.id).status).toBe('QUEUED')
    expect(() => service.get('run-2', first.id)).toThrow(/unknown run/)
    service.cancel(RUN_ID, first.id)
    service.cancel(RUN_ID, second.id)
    service.cancel(RUN_ID, third.id)
  })

  workerIt('close terminates running workers, awaits them and marks the jobs failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-modeling-close-')); dirs.push(dir)
    const service = makeService(dir, { workerScript: fixtureFile(PARTIAL_SOURCE, 'partial.py'), concurrency: 1 })
    const task = submit(service)
    await waitStatus(service, task.id, 'RUNNING')
    const started = Date.now()
    await service.close()
    expect(Date.now() - started).toBeLessThan(5_000)
    const after = service.get(RUN_ID, task.id)
    expect(after.status).toBe('FAILED')
    expect(after.error).toMatch(/shutdown/)
    expect(existsSync(join(taskDir(dir, task.id), 'output.csv'))).toBe(false)
  })
})
