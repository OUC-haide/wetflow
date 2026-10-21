import { fileURLToPath } from 'node:url'
import * as feedComparison from './feed-comparison.js'
import * as education from './education.js'
import * as evidence from './evidence.js'
import * as research from './research.js'
import * as modeling from './modeling.js'
import * as experiment from './experiment.js'
import { PLUGIN_IDS, OPTIONAL_PLUGIN_IDS, MANAGED_PLUGIN_IDS, type PluginFiber, type PluginId, type WetFlowContext } from './types.js'

export interface PluginOptions {
  research: research.Config
  modeling: modeling.Config
  experiment: experiment.Config
  'feed-comparison'?: feedComparison.Config
  education?: education.Config
}
const modules = { evidence, research, modeling, experiment, 'feed-comparison': feedComparison, education }
const serviceKeys = { evidence: 'wetflowEvidence', research: 'wetflowResearch', modeling: 'wetflowModeling', experiment: 'wetflowExperiment', 'feed-comparison': 'wetflowFeedComparison', education: 'wetflowEducation' } as const

/** A small host controller. Resource ownership and cleanup remain in Cordis fibers. */
export class WetFlowPlugins {
  private readonly fibers = new Map<PluginId, PluginFiber>()
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  constructor(private readonly ctx: WetFlowContext, private readonly options: PluginOptions) {}
  snapshot() {
    const describe = (id: PluginId) => ({
      id, name: `${id[0]!.toUpperCase()}${id.slice(1)} Plugin`,
      enabled: this.fibers.has(id),
      loaded: this.fibers.get(id)?.state === 2 && Boolean(this.ctx[serviceKeys[id]]),
      serviceAvailable: Boolean(this.ctx[serviceKeys[id]]),
      tools: this.ctx.wetflow.tools.ownedBy(id),
    })
    return { plugins: PLUGIN_IDS.map(describe), extensions: OPTIONAL_PLUGIN_IDS.map(describe), tools: this.ctx.wetflow.tools.list().map(tool => tool.name) }
  }
  load(id: PluginId): Promise<ReturnType<WetFlowPlugins['snapshot']>> {
    return this.exclusive(async () => {
      if (this.closed) throw new Error('Plugin manager is closed')
      this.assertId(id)
      if (!this.fibers.has(id)) {
        const pending = this.ctx.plugin(modules[id], id === 'evidence' ? {} : (this.options[id] ?? (id === 'feed-comparison'
          ? { summaryPath: fileURLToPath(new URL('../../examples/md-five-feed-summary.json', import.meta.url)) }
          : { libraryPath: fileURLToPath(new URL('../../examples/education/education-library.json', import.meta.url)) })))
        try {
          const fiber = await pending
          this.fibers.set(id, fiber)
        } catch (error) {
          // Cordis returns a disposable thenable even when plugin setup fails.
          await (pending as unknown as PluginFiber).dispose()
          throw error
        }
      }
      return this.snapshot()
    })
  }
  unload(id: PluginId): Promise<ReturnType<WetFlowPlugins['snapshot']>> {
    return this.exclusive(async () => { this.assertId(id); await this.remove(id); return this.snapshot() })
  }
  async close(): Promise<void> {
    await this.exclusive(async () => {
      this.closed = true
      for (const id of [...this.fibers.keys()].reverse()) await this.remove(id)
    })
  }
  private async remove(id: PluginId): Promise<void> {
    const fiber = this.fibers.get(id)
    if (!fiber) return
    await fiber.dispose()
    this.fibers.delete(id)
  }
  private assertId(id: string): asserts id is PluginId {
    if (!MANAGED_PLUGIN_IDS.includes(id as PluginId)) throw new Error(`Unknown plugin: ${id}`)
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action)
    this.queue = next.catch(() => {})
    return next
  }
}
export async function createWetFlowPlugins(ctx: WetFlowContext, options: PluginOptions): Promise<WetFlowPlugins> {
  const manager = new WetFlowPlugins(ctx, options)
  ctx.effect(() => () => manager.close(), 'WetFlow domain plugins')
  ctx.reflect.provide('wetflowPlugins', manager)
  return manager
}
