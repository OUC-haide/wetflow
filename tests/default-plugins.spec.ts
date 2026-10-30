import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from '../src/server.js'
import { createConsoleContext } from '../src/cli.js'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-default-plugins-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function options(dir: string) {
  return { dbPath: join(dir, 'core.db'), settingsPath: join(dir, 'model-settings.json'),
    industrialDbPath: join(dir, 'industrial.db'), industrialSettingsPath: join(dir, 'industrial-settings.json'),
    researchDbPath: join(dir, 'research.db'), modelingDataDir: join(dir, 'modeling'), serveWeb: false }
}
const enabled = ['evidence', 'research', 'modeling', 'experiment', 'feed-comparison', 'local-files', 'document-media', 'workflow-planner', 'batch-data']

describe('bundled plugin defaults', () => {
  it('starts the web host with all nine research plugins usable and Education off', async () => {
    const app = await createServer(options(directory()))
    cleanup.push(() => app.close())
    const state = (await app.inject('/api/plugins')).json()
    const all = [...state.plugins, ...state.extensions]
    expect(all).toHaveLength(10)
    expect(all.filter(p => p.loaded).map(p => p.id).sort()).toEqual([...enabled].sort())
    expect(all.find(p => p.id === 'education')).toMatchObject({ enabled: false, loaded: false, tools: [] })
    const probe = await app.inject('/api/plugins/feed-comparison/probe')
    expect(probe.statusCode).toBe(200)
    expect(JSON.stringify(probe.json())).toContain('25.2')
    expect(state.tools).toEqual(expect.arrayContaining(['local_file_read', 'batch_data_compare', 'workflow_set_plan', 'md_compare_feeds', 'research_search', 'modeling_methods']))
    expect(state.tools).not.toContain('education_search_cases')
  })

  it('shares persisted user choices across web and CLI without re-enabling disabled plugins', async () => {
    const dir = directory()
    const app = await createServer(options(dir))
    try {
      expect((await app.inject({ method: 'POST', url: '/api/plugins/education/load' })).statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: '/api/plugins/feed-comparison/unload' })).statusCode).toBe(200)
    } finally { await app.close() }
    vi.stubEnv('WETFLOW_DB', join(dir, 'core.db'))
    vi.stubEnv('WETFLOW_MODEL_BASE_URL', '')
    const { ctx, plugins } = await createConsoleContext()
    cleanup.push(() => ctx.fiber.dispose())
    expect(plugins.snapshot().extensions.find(p => p.id === 'education')?.loaded).toBe(true)
    expect(ctx.wetflow.tools.instructions()).toContain('W—Wonder（思索）')
    expect(ctx.wetflow.tools.has('md_compare_feeds')).toBe(false)
    expect(ctx.wetflow.tools.has('local_file_read')).toBe(true)
  })

  it('starts the CLI with the same defaults, executes the saved MD comparison and reads a local file', async () => {
    const dir = directory()
    vi.stubEnv('WETFLOW_DB', join(dir, 'core.db'))
    vi.stubEnv('WETFLOW_MODEL_BASE_URL', '')
    const { ctx, plugins } = await createConsoleContext()
    cleanup.push(() => ctx.fiber.dispose())
    const state = plugins.snapshot()
    expect([...state.plugins, ...state.extensions].filter(p => p.loaded).map(p => p.id).sort()).toEqual([...enabled].sort())
    expect(ctx.wetflow.tools.instructions()).not.toContain('Education 插件已启用')
    const result = await ctx.wetflow.tools.get('md_compare_feeds').execute({ baselineFeed: 1, comparisonFeed: 1.25 })
    expect(result).toMatchObject({ fractionChangePercentagePoints: -20 })
    const path = join(dir, 'protocol.txt')
    writeFileSync(path, 'A user-supplied protocol.')
    expect(JSON.stringify(await ctx.wetflow.tools.get('local_file_read').execute({ path }))).toContain('A user-supplied protocol.')
    const methods = await ctx.wetflow.tools.get('modeling_methods').execute({})
    expect(JSON.stringify(methods)).toContain('monod_batch')
  })
})
