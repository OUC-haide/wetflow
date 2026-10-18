import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWetFlowContext } from '../src/cordis.js'
import { createWetFlowPlugins, PLUGIN_IDS, ModelingPlugin, type WetFlowContext } from '../src/plugins/index.js'
import { ToolRegistry } from '../src/agent/tools.js'
import { createServer } from '../src/server.js'
import type { ModelProvider } from '../src/agent/provider.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-plugins-'))
  cleanups.push(async () => { rmSync(dir, { recursive: true, force: true }) })
  const ctx = await createWetFlowContext({ dbPath: join(dir, 'core.db'), allowDocumentExcerpts: () => true })
  cleanups.push(() => ctx.fiber.dispose())
  const options = {
    experiment: { dbPath: join(dir, 'experiment.db') },
    research: { dbPath: join(dir, 'research.db'), modeling: () => { if (!ctx.wetflowModeling) throw new Error('Modeling Plugin is unloaded'); return ctx.wetflowModeling } },
    modeling: { dataDir: join(dir, 'modeling'), createPrediction: () => ({ id: 'test-prediction' }) },
  }
  const plugins = await createWetFlowPlugins(ctx, options)
  return { dir, ctx, plugins, options }
}

describe('Cordis domain plugin lifecycle', () => {
  it('adds and removes each real tool group and its Cordis service without affecting others', async () => {
    const { ctx, plugins } = await harness()
    const baseline = plugins.snapshot().tools
    expect(baseline).toHaveLength(4)
    for (const id of PLUGIN_IDS) await plugins.load(id)
    const all = plugins.snapshot()
    expect(all.plugins.every(item => item.loaded && item.tools.length > 0)).toBe(true)
    for (const id of PLUGIN_IDS) {
      const own = ctx.wetflow.tools.ownedBy(id)
      const others = plugins.snapshot().tools.filter(name => !own.includes(name))
      const stale = ctx.wetflow.tools.get(own[0]!)
      await plugins.unload(id)
      expect(plugins.snapshot().tools).toEqual(others)
      expect(plugins.snapshot().plugins.find(item => item.id === id)).toMatchObject({ loaded: false, serviceAvailable: false, tools: [] })
      expect(() => stale.execute({})).toThrow('unloaded')
      await plugins.load(id)
      expect([...ctx.wetflow.tools.ownedBy(id)].sort()).toEqual([...own].sort())
    }
    await plugins.close()
    expect(ctx.wetflow.tools.list().map(tool => tool.name)).toEqual(baseline)
  })

  it('publishes the live tool schema to the model before load, after load and after unload', async () => {
    const { ctx, plugins } = await harness()
    const seen: string[][] = []
    const provider: ModelProvider = {
      models: async () => [{ id: 'test', label: 'Test provider' }], defaultModel: () => 'test',
      complete: async (_context, tools, _options, session) => {
        seen.push(tools.definitions().map(tool => tool.name))
        if (!session?.messages.length) return { content: '', toolCall: { id: 'probe', name: 'modeling_methods', arguments: {} } }
        return { content: 'Lifecycle probe complete.' }
      },
    }
    ctx.wetflow.setProvider(provider)
    for (const stage of ['before', 'loaded', 'unloaded']) {
      if (stage === 'loaded') await plugins.load('modeling')
      if (stage === 'unloaded') await plugins.unload('modeling')
      const snapshot = await ctx.wetflow.chat('List modeling methods')
      expect(snapshot.turn?.toolSuccesses ?? 0).toBe(stage === 'loaded' ? 1 : 0)
      expect(seen.at(-1)?.includes('modeling_methods')).toBe(stage === 'loaded')
    }
  })

  it('supports repeated and concurrent load/unload without duplicate registration', async () => {
    const { ctx, plugins } = await harness()
    for (let i = 0; i < 5; i++) {
      await Promise.all([plugins.load('modeling'), plugins.load('modeling')])
      expect(ctx.wetflow.tools.ownedBy('modeling').length).toBeGreaterThan(0)
      const names = plugins.snapshot().tools
      expect(new Set(names).size).toBe(names.length)
      await Promise.all([plugins.unload('modeling'), plugins.unload('modeling')])
      expect(plugins.snapshot().tools).toHaveLength(4)
    }
  })

  it('preserves imported files, stops automatic retrieval on unload, and restores it on reload', async () => {
    const { ctx, plugins } = await harness()
    await plugins.load('evidence')
    ctx.wetflowEvidence!.add('source.md', 'Unique marker: PMA dopamine feed comparison.')
    const sourceId = ctx.wetflowEvidence!.sources()[0]!.id
    expect((await ctx.wetflow.chat('根据 PMA dopamine feed comparison')).messages.at(-1)?.content).toContain('Unique marker')
    await plugins.unload('evidence')
    expect((await ctx.wetflow.chat('根据 PMA dopamine feed comparison')).messages.at(-1)?.content).not.toContain('Unique marker')
    await plugins.load('evidence')
    expect(ctx.wetflowEvidence!.sources()[0]!.id).toBe(sourceId)
    expect((await ctx.wetflow.chat('根据 PMA dopamine feed comparison')).messages.at(-1)?.content).toContain('Unique marker')
  })

  it('rolls back a failed plugin registration and allows a corrected reload', async () => {
    const { ctx, plugins, options } = await harness()
    const conflict = ctx.wetflow.tools.mount('fixture', registry => registry.register({ name: 'modeling_methods', description: '', approvalRequired: false, risk: 'LOW', execute: () => null }))
    await expect(plugins.load('modeling')).rejects.toThrow('already registered')
    expect(ctx.wetflowModeling).toBeUndefined()
    expect(ctx.wetflow.tools.ownedBy('modeling')).toEqual([])
    conflict()
    await plugins.load('modeling')
    expect(ctx.wetflowModeling).toBeDefined()
    expect(existsSync(options.modeling.dataDir)).toBe(true)
  })

  it('cleans up a running worker on unload and retains the terminal task record on reload', async () => {
    const { ctx, options, dir } = await harness()
    const script = join(dir, 'slow.py')
    writeFileSync(script, 'import time\ntime.sleep(30)\n')
    const fiber = await ctx.plugin(ModelingPlugin, { ...options.modeling, workerScript: script })
    const runId = ctx.wetflow.store.activeWorkflowRunId()
    const service = ctx.wetflowModeling!
    const task = service.submit(runId, { method: 'monod_batch', parameters: { initialBiomass: 0.1, initialSubstrate: 10, muMax: 0.3, halfSaturation: 1, yield: 0.5, duration: 2, timeStep: 0.1 } })
    await expect.poll(() => service.get(runId, task.id).status).toBe('RUNNING')
    await fiber.dispose()
    expect(ctx.wetflowModeling).toBeUndefined()
    expect(() => service.submit(runId, { method: 'growth_fit', parameters: {} })).toThrow('closed')
    await ctx.plugin(ModelingPlugin, options.modeling)
    expect(ctx.wetflowModeling!.get(runId, task.id)).toMatchObject({ status: 'FAILED', error: 'Service shutdown' })
  })

  it('lets Cordis activate and dispose a dependent plugin when its service appears and disappears', async () => {
    const { ctx, plugins } = await harness()
    let starts = 0, stops = 0
    const dependent = ctx.plugin({
      name: 'modeling-consumer-test', inject: ['wetflowModeling'],
      apply: (scope: WetFlowContext) => { starts++; scope.effect(() => () => { stops++ }, 'consumer cleanup') },
    })
    await dependent
    expect(starts).toBe(0)
    await plugins.load('modeling')
    await dependent
    expect(starts).toBe(1)
    await plugins.unload('modeling')
    expect(stops).toBe(1)
    await plugins.load('modeling')
    await dependent
    expect(starts).toBe(2)
  })

  it('aborts an in-flight document fetch before closing the Research database', async () => {
    const { ctx, options } = await harness()
    let aborted = false
    let begin!: () => void
    const started = new Promise<void>(resolve => { begin = resolve })
    options.research = { ...options.research }
    const { ResearchPlugin } = await import('../src/plugins/index.js')
    const fiber = await ctx.plugin(ResearchPlugin, { ...options.research,
      search: async () => [{ provider: 'europepmc', externalId: 'test', title: 'Test source', url: 'https://europepmc.org/article/MED/test' }],
      fetch: async (_hit: unknown, signal: AbortSignal) => {
        begin()
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')) }, { once: true }))
      },
    })
    const service = ctx.wetflowResearch!
    const runId = ctx.wetflow.store.activeWorkflowRunId()
    const job = service.startJob(runId, { query: 'test', providers: ['europepmc'] })
    await expect.poll(() => service.job(runId, job.id).status).toBe('COMPLETED')
    const pending = service.fetchSource(runId, service.sources(runId).items[0]!.id).catch(error => error as Error)
    await started
    await fiber.dispose()
    expect(aborted).toBe(true)
    expect((await pending) as Error).toBeInstanceOf(Error)
    expect(ctx.wetflowResearch).toBeUndefined()
  })

  it('removes services and registrations when the entire Cordis context is disposed', async () => {
    const { ctx, plugins } = await harness()
    for (const id of PLUGIN_IDS) await plugins.load(id)
    const registry = ctx.wetflow.tools
    await ctx.fiber.dispose()
    expect(ctx.wetflowModeling).toBeUndefined()
    expect(ctx.wetflowResearch).toBeUndefined()
    expect(PLUGIN_IDS.flatMap(id => registry.ownedBy(id))).toEqual([])
  })
})

describe('plugin REST lifecycle', () => {
  it('makes modeling available only while loaded, preserves other tools, and rejects unknown plugins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-plugin-rest-'))
    const app = await createServer({ dbPath: join(dir, 'core.db'), researchDbPath: join(dir, 'research.db'), modelingDataDir: join(dir, 'modeling'), industrialDbPath: join(dir, 'experiment.db'), industrialSettingsPath: join(dir, 'settings.json'), settingsPath: join(dir, 'model-settings.json'), serveWeb: false })
    try {
      const before = (await app.inject('/api/plugins')).json()
      expect(before.plugins.every((p: { loaded: boolean }) => p.loaded)).toBe(true)
      expect((await app.inject('/api/plugins/modeling-probe')).statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: '/api/plugins/modeling/unload' })).statusCode).toBe(200)
      expect((await app.inject('/api/modeling/methods')).statusCode).toBe(503)
      expect((await app.inject('/api/plugins/modeling-probe')).statusCode).toBe(409)
      expect((await app.inject('/api/research/profile?runId=wf-demo')).statusCode).toBe(200)
      await app.inject({ method: 'POST', url: '/api/plugins/modeling/load' })
      expect((await app.inject('/api/plugins/modeling-probe')).statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: '/api/plugins/not-a-plugin/load' })).statusCode).toBe(404)
      for (const [id, path] of [['research', '/api/research/jobs'], ['experiment', '/api/industrial/parameters'], ['evidence', '/api/evidence']]) {
        await app.inject({ method: 'POST', url: `/api/plugins/${id}/unload` })
        expect((await app.inject(path!)).statusCode).toBe(503)
      }
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
