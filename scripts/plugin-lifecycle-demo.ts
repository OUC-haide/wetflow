import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../src/server.js'

const output = resolve(process.argv[2] ?? 'artifacts/plugin-lifecycle')
const temp = mkdtempSync(join(tmpdir(), 'wetflow-plugin-demo-'))
const app = await createServer({ dbPath: join(temp, 'core.db'), researchDbPath: join(temp, 'research.db'), industrialDbPath: join(temp, 'experiment.db'), industrialSettingsPath: join(temp, 'experiment-settings.json'), settingsPath: join(temp, 'model-settings.json'), modelingDataDir: join(temp, 'modeling'), plugins: ['evidence', 'research', 'experiment'], serveWeb: false })
const steps: Array<Record<string, unknown>> = []
try {
  const capture = async (stage: string) => {
    const snapshot = (await app.inject('/api/plugins')).json()
    const probe = await app.inject('/api/plugins/modeling-probe')
    const model = snapshot.plugins.find((p: { id: string }) => p.id === 'modeling')
    const row = { stage, capturedAt: new Date().toISOString(), totalTools: snapshot.tools.length, modelingTools: model.tools.length, modelingService: model.serviceAvailable, probeStatus: probe.statusCode, probe: probe.json(), toolNames: snapshot.tools, plugins: snapshot.plugins }
    steps.push(row)
    console.log(`${stage.padEnd(12)} | Agent tools ${row.totalTools} | Modeling tools ${row.modelingTools} | tool call HTTP ${row.probeStatus}`)
    return row
  }
  const before = await capture('started')
  assert.equal(before.modelingTools, 0)
  assert.equal(before.probeStatus, 409)
  assert.equal((await app.inject({ method: 'POST', url: '/api/plugins/modeling/load' })).statusCode, 200)
  const loaded = await capture('loaded')
  assert.ok(loaded.modelingTools > 0)
  assert.equal(loaded.probeStatus, 200)
  assert.equal((await app.inject({ method: 'POST', url: '/api/plugins/modeling/unload' })).statusCode, 200)
  const unloaded = await capture('unloaded')
  assert.equal(unloaded.modelingTools, 0)
  assert.equal(unloaded.probeStatus, 409)
  assert.deepEqual(unloaded.toolNames, before.toolNames)
  assert.equal((await app.inject({ method: 'POST', url: '/api/plugins/modeling/load' })).statusCode, 200)
  const reloaded = await capture('reloaded')
  assert.deepEqual(reloaded.toolNames, loaded.toolNames)
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'plugin-lifecycle-results.json'), JSON.stringify({ executedAt: new Date().toISOString(), framework: 'Cordis 4.0.0-rc.8', source: 'Real Fastify handlers, Cordis fibers, Agent registry and modeling_methods execution; no external model call', passed: true, steps }, null, 2) + '\n')
  writeFileSync(join(output, 'plugin-lifecycle-results.csv'), 'stage,total_agent_tools,modeling_tools,modeling_service,tool_call_http\n' + steps.map(s => [s.stage, s.totalTools, s.modelingTools, s.modelingService, s.probeStatus].join(',')).join('\n') + '\n')
} finally { await app.close(); rmSync(temp, { recursive: true, force: true }) }
