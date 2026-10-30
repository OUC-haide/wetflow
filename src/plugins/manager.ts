import { dirname, join } from 'node:path'
import * as batchData from './batch-data.js'
import * as localFiles from './local-files.js'
import * as documentMedia from './document-media.js'
import * as workflowPlanner from './workflow-planner.js'
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
  'batch-data'?: batchData.Config
  'local-files'?: localFiles.Config
  'document-media'?: Record<string, never>
  'workflow-planner'?: Record<string, never>
}
const modules = { 'batch-data': batchData, 'local-files': localFiles, 'document-media': documentMedia, 'workflow-planner': workflowPlanner, evidence, research, modeling, experiment, 'feed-comparison': feedComparison, education }
const serviceKeys = { 'batch-data': 'wetflowBatchData', 'local-files': 'wetflowLocalFiles', 'document-media': 'wetflowDocumentMedia', 'workflow-planner': 'wetflowPlanner', evidence: 'wetflowEvidence', research: 'wetflowResearch', modeling: 'wetflowModeling', experiment: 'wetflowExperiment', 'feed-comparison': 'wetflowFeedComparison', education: 'wetflowEducation' } as const

/** A small host controller. Resource ownership and cleanup remain in Cordis fibers. */
export class WetFlowPlugins {
  private readonly fibers = new Map<PluginId, PluginFiber>()
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  constructor(private readonly ctx: WetFlowContext, private readonly options: PluginOptions) {}
  snapshot() {
    const describe = (id: PluginId) => ({
      id, name: ({ 'local-files': '本地文件', 'document-media': 'PDF 与多模态', 'workflow-planner': '共同规划流程', 'batch-data': '多批次数据' } as Partial<Record<PluginId, string>>)[id] ?? `${id[0]!.toUpperCase()}${id.slice(1)} Plugin`,
      dependencies: id === 'document-media' ? ['local-files'] : id === 'education' ? ['evidence'] : [],
      panels: id === 'batch-data' ? [{ id: 'batch-data', label: '多批次数据', icon: 'database' }] : [],
      enabled: this.fibers.has(id),
      loaded: this.fibers.get(id)?.state === 2 && Boolean(this.ctx[serviceKeys[id]]),
      serviceAvailable: Boolean(this.ctx[serviceKeys[id]]),
      tools: this.ctx.wetflow.tools.ownedBy(id),
    })
    return { plugins: PLUGIN_IDS.map(describe), extensions: OPTIONAL_PLUGIN_IDS.map(describe), tools: this.ctx.wetflow.tools.list().map(tool => tool.name),
      education: this.ctx.wetflowEducation?.catalogue() ?? null }
  }
  load(id: PluginId): Promise<ReturnType<WetFlowPlugins['snapshot']>> {
    return this.exclusive(async () => {
      if (this.closed) throw new Error('Plugin manager is closed')
      this.assertId(id)
      if (!this.fibers.has(id)) {
        const base = dirname(this.options.experiment.dbPath === ':memory:' ? '.wetflow/industrial.db' : this.options.experiment.dbPath)
        const defaults = { evidence: {}, 'document-media': {}, 'workflow-planner': {},
          'local-files': { directory: join(base, 'attachments') },
          'batch-data': { dbPath: this.options.experiment.dbPath === ':memory:' ? ':memory:' : join(base, 'batch-data.db') },
          'feed-comparison': { summaryPath: fileURLToPath(new URL('../../examples/md-five-feed-summary.json', import.meta.url)) },
          education: { libraryPath: fileURLToPath(new URL('../../examples/education/education-library.json', import.meta.url)) } }
        const config = id === 'evidence' ? {} : this.options[id] ?? defaults[id as keyof typeof defaults] ?? {}
        const pending = this.ctx.plugin(modules[id], config)
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
