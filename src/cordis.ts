import { z } from 'zod'
import { WetFlowStore } from './core/store.js'
import { WetFlowAgent } from './agent/runtime.js'
import { OpenAICompatibleProvider } from './agent/provider.js'
import type { ToolRegistry } from './agent/tools.js'

interface CordisContext {
  wetflow: WetFlowAgent
  reflect: { provide(name: string, value: unknown): unknown }
  effect(execute: () => () => void, label?: string): unknown
  plugin(plugin: unknown, config?: unknown): PromiseLike<unknown>
  fiber: { dispose(): Promise<void> }
}

type CordisContextConstructor = new () => CordisContext

export interface Config {
  dbPath?: string
  modelBaseUrl?: string
  modelApiKey?: string
  model?: string
  models?: string[]
  contextTokenBudget?: number
  /**
   * Host hook forwarded to `WetFlowAgentOptions.registerTools`, so the server
   * can register domain tools without the agent framework owning them.
   */
  registerTools?: (registry: ToolRegistry) => void
  /** Lazily adds a bounded run summary when research mode is enabled. */
  additionalContext?: (workflowRunId: string) => string
  /** Consent for sending automatically retrieved document excerpts to models. */
  allowDocumentExcerpts?: () => boolean
}

export const Config = z.object({
  dbPath: z.string().default('.wetflow/wetflow-agent.db'),
  modelBaseUrl: z.string().default(''),
  modelApiKey: z.string().default(''),
  model: z.string().default(''),
  models: z.array(z.string()).default([]),
  contextTokenBudget: z.number().int().min(1_024).max(100_000).default(6_000),
  registerTools: z.function().optional(),
  additionalContext: z.function().optional(),
  allowDocumentExcerpts: z.function().optional(),
})

export const name = 'wetflow-agent'

export function apply(ctx: CordisContext, config: Config): void {
  const store = new WetFlowStore(config.dbPath ?? '.wetflow/wetflow-agent.db')
  const provider = config.modelBaseUrl && config.modelApiKey
    ? new OpenAICompatibleProvider({
      baseUrl: config.modelBaseUrl,
      apiKey: config.modelApiKey,
      model: config.model ?? '',
      models: config.models ?? [],
    })
    : undefined
  const agent = new WetFlowAgent(store, provider, {
    ...(config.contextTokenBudget ? { contextTokenBudget: config.contextTokenBudget } : {}),
    ...(config.registerTools ? { registerTools: config.registerTools } : {}),
    ...(config.additionalContext ? { additionalContext: config.additionalContext } : {}),
    ...(config.allowDocumentExcerpts ? { allowDocumentExcerpts: config.allowDocumentExcerpts } : {}),
  })
  ctx.reflect.provide('wetflow', agent)
  ctx.effect(() => () => {
    agent.dispose()
    store.close()
  }, 'wetflow-agent lifecycle')
}

export type WetFlowContext = CordisContext

export async function createWetFlowContext(config: Config = {}): Promise<WetFlowContext> {
  // Cordis 4.0.0-rc.8's declaration barrel omits the Context value export,
  // while its documented ESM runtime exports it. Keep the workaround local.
  const runtime = await import('cordis') as unknown as { Context: CordisContextConstructor }
  const ctx = new runtime.Context()
  await ctx.plugin({ name, Config, apply }, config)
  return ctx as WetFlowContext
}
