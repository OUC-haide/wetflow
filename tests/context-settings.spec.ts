import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/server.js'
import { WetFlowStore } from '../src/core/store.js'
import { WetFlowAgent } from '../src/agent/runtime.js'
import { Config } from '../src/cordis.js'
import type { ModelContextFrame } from '../src/agent/context.js'

describe('adjustable context budget', () => {
  it('saves up to one million tokens, rejects invalid values, and restores on restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-context-settings-'))
    const options = { settingsPath: join(dir, 'settings.json'), dbPath: join(dir, 'workflow.db'),
      industrialDbPath: join(dir, 'industrial.db'), industrialSettingsPath: join(dir, 'industrial.json'),
      researchDbPath: join(dir, 'research.db'), modelingDataDir: join(dir, 'modeling'), serveWeb: false }
    let app = await createServer(options)
    try {
      expect((await app.inject('/api/snapshot')).json().context.tokenBudget).toBe(128_000)
      for (const tokenBudget of [1_024, 6_000, 128_000, 1_000_000]) {
        const result = await app.inject({ method: 'PATCH', url: '/api/context-settings', payload: { tokenBudget } })
        expect(result.statusCode).toBe(200)
        expect(result.json().context.tokenBudget).toBe(tokenBudget)
      }
      for (const tokenBudget of [0, 1023, 1_000_001, 6000.5, '1000000', null]) {
        expect((await app.inject({ method: 'PATCH', url: '/api/context-settings', payload: { tokenBudget } })).statusCode).toBe(400)
      }
      expect((await app.inject('/api/snapshot')).json().context.tokenBudget).toBe(1_000_000)
      await app.close()
      app = await createServer(options)
      expect((await app.inject('/api/snapshot')).json().context.tokenBudget).toBe(1_000_000)
      expect(Config.parse({ contextTokenBudget: 1_000_000 }).contextTokenBudget).toBe(1_000_000)
      expect(() => Config.parse({ contextTokenBudget: 1_000_001 })).toThrow()
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('restores older original messages to actual model context when the budget increases', async () => {
    const store = new WetFlowStore(':memory:')
    let seen: ModelContextFrame | undefined
    const provider = { complete: async (context: ModelContextFrame) => { seen = context; return { content: 'Done.' } },
      models: async () => [{ id: 'fixture', label: 'fixture' }], defaultModel: () => 'fixture' }
    const agent = new WetFlowAgent(store, provider, { contextTokenBudget: 6000, allowDocumentExcerpts: () => true })
    try {
      agent.newConversation()
      for (let i = 0; i < 21; i++) store.addMessage(i % 2 ? 'assistant' : 'user', `Message ${i}: ${'context '.repeat(200)}`)
      const small = agent.snapshot().context
      expect(small.omittedMessages).toBeGreaterThan(0)
      expect(small.memoryMessages).toBeGreaterThan(0)
      agent.setContextTokenBudget(1_000_000)
      const large = agent.snapshot().context
      expect(large.selectedMessages).toBe(21)
      expect(large.memoryMessages).toBe(0)
      expect(large.omittedMessages).toBe(0)
      await agent.chat('Read the conversation.')
      expect(seen?.messages).toHaveLength(22)
      expect(seen?.messages[0]?.content).toContain('Message 0:')
      expect(seen?.stats.tokenBudget).toBe(1_000_000)
      agent.setContextTokenBudget(6000)
      expect(agent.snapshot().context.omittedMessages).toBeGreaterThan(0)
    } finally { agent.dispose(); store.close() }
  })
})
