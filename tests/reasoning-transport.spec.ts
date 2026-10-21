import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from '../src/server.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(model = 'deepseek-flash', toolRoundTrip = false) {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-reasoning-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const bodies: Array<Record<string, any>> = []
  const upstream = createHttpServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    bodies.push(JSON.parse(raw))
    res.setHeader('Content-Type', 'application/json')
    const message = toolRoundTrip && bodies.length === 1
      ? { content: '', reasoning_content: 'Inspect the state.', tool_calls: [{
        id: 'state-1', type: 'function', function: { name: 'workflow_status', arguments: '{}' },
      }] }
      : { content: 'Local transport test completed.', ...(bodies.at(-1)!.thinking?.type === 'enabled' ? { reasoning_content: 'The response is ready.' } : {}) }
    res.end(JSON.stringify({ choices: [{ message }] }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('No local test listener')
  const settingsPath = join(dir, 'settings.json')
  writeFileSync(join(dir, 'privacy-settings.json'), JSON.stringify({ allowDocumentExcerpts: toolRoundTrip }))
  writeFileSync(settingsPath, JSON.stringify({ provider: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-fixture-only', model }))
  const app = await createServer({ dbPath: join(dir, 'workflow.db'), settingsPath,
    industrialDbPath: join(dir, 'industrial.db'), industrialSettingsPath: join(dir, 'industrial.json'),
    modelingDataDir: join(dir, 'modeling'), serveWeb: false })
  cleanup.push(() => app.close())
  return { app, bodies }
}

describe('reasoning settings reach the HTTP model request', () => {
  it('advertises DeepSeek choices and sends each selection to the upstream API', async () => {
    const { app, bodies } = await fixture()
    const catalog = (await app.inject('/api/models')).json()
    expect(catalog.reasoningEfforts.map((item: { id: string }) => item.id)).toEqual(['off', 'low', 'high', 'max'])
    expect(catalog.defaultReasoningEffort).toBe('high')
    for (const effort of ['off', 'low', 'high', 'max', 'medium', undefined]) {
      const result = await app.inject({ method: 'POST', url: '/api/chat',
        payload: { content: 'Report the selected configuration.', ...(effort ? { reasoningEffort: effort } : {}) } })
      expect(result.statusCode).toBe(200)
      const body = bodies.at(-1)!
      expect(body.model).toBe('deepseek-flash')
      expect(body.thinking).toEqual({ type: effort === 'off' ? 'disabled' : 'enabled' })
      if (effort === 'off') expect(body).not.toHaveProperty('reasoning_effort')
      else {
        expect(body.reasoning_effort).toBe(effort === 'medium' || effort === undefined ? 'high' : effort)
        expect(body).not.toHaveProperty('temperature')
      }
    }
    expect(bodies).toHaveLength(6)
  })

  it('preserves max effort and reasoning content through a tool-call continuation', async () => {
    const { app, bodies } = await fixture('deepseek-flash', true)
    const response = await app.inject({ method: 'POST', url: '/api/chat',
      payload: { content: 'Read the current workflow status.', reasoningEffort: 'max' } })
    expect(response.statusCode).toBe(200)
    expect(bodies).toHaveLength(2)
    for (const body of bodies) expect(body).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'max' })
    expect(bodies[1]!.messages).toContainEqual(expect.objectContaining({ role: 'assistant', reasoning_content: 'Inspect the state.' }))
    expect(bodies[1]!.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'state-1' }))
    const saved = response.json().messages.at(-1)
    expect(saved.reasoningContent).toBe('Inspect the state.\n\nThe response is ready.')
    expect((await app.inject('/api/snapshot')).json().messages.at(-1).reasoningContent).toBe(saved.reasoningContent)
    await app.inject({ method: 'POST', url: '/api/chat', payload: { content: 'Next question.', reasoningEffort: 'off' } })
    expect(JSON.stringify(bodies.at(-1)!.messages)).not.toContain('Inspect the state.')
    expect((await app.inject('/api/snapshot')).json().messages.at(-1)).not.toHaveProperty('reasoningContent')
  })

  it('uses the new effort when an earlier user message is edited and resent', async () => {
    const { app, bodies } = await fixture()
    const initial = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: 'First question.', reasoningEffort: 'low' } })
    const user = initial.json().messages.find((message: { role: string; content: string }) => message.role === 'user' && message.content === 'First question.')
    expect(user).toBeDefined()
    const edited = await app.inject({ method: 'PATCH', url: `/api/messages/${user.id}`,
      payload: { content: 'Revised question.', reasoningEffort: 'max' } })
    expect(edited.statusCode).toBe(200)
    expect(bodies.at(-1)).toMatchObject({ reasoning_effort: 'max', thinking: { type: 'enabled' } })
  })

  it('keeps generic provider parameters independent from DeepSeek', async () => {
    const { app, bodies } = await fixture('generic-model')
    const catalog = (await app.inject('/api/models')).json()
    expect(catalog.reasoningEfforts.map((item: { id: string }) => item.id)).toEqual(['low', 'medium', 'high'])
    await app.inject({ method: 'POST', url: '/api/chat', payload: { content: 'A generic request.', reasoningEffort: 'medium' } })
    expect(bodies[0]).toMatchObject({ model: 'generic-model', reasoning_effort: 'medium', temperature: 0.2 })
    expect(bodies[0]).not.toHaveProperty('thinking')
  })

  it('rejects malformed efforts without calling the model', async () => {
    const { app, bodies } = await fixture()
    for (const effort of ['extreme', '', null, 42]) {
      const result = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: 'Bad setting.', reasoningEffort: effort } })
      expect(result.statusCode).toBe(400)
    }
    expect(bodies).toHaveLength(0)
  })
})
