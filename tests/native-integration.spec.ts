import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from '../src/server.js'

/**
 * End-to-end tests over the real HTTP surface with a local fake
 * OpenAI-compatible provider. No external network and no paid model call is
 * made: the product performs real `fetch` requests to 127.0.0.1.
 */

const temporary: string[] = []
const closers: Array<() => unknown> = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    try { await close() } catch { /* best-effort test cleanup */ }
  }
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface FakeMessage {
  role?: string
  content?: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  _httpStatus?: number
}

async function fakeProvider(
  handler: (body: Record<string, unknown>, call: number) => FakeMessage,
): Promise<{ calls: Array<Record<string, unknown>>; baseURL: string }> {
  const calls: Array<Record<string, unknown>> = []
  const server = createHttpServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw) as Record<string, unknown>
    calls.push(body)
    const message = handler(body, calls.length)
    if (message._httpStatus) { response.writeHead(message._httpStatus).end('{}'); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      model: 'fixture-model', choices: [{ message }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  closers.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return { calls, baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

function toolCall(id: string, name: string, args: Record<string, unknown>): FakeMessage {
  return { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
}

async function harness(baseURL: string) {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-native-integration-'))
  temporary.push(dir)
  const app = await createServer({
    dbPath: join(dir, 'wetflow.db'),
    industrialDbPath: join(dir, 'industrial.db'),
    industrialSettingsPath: join(dir, 'industrial-settings.json'),
    settingsPath: join(dir, 'model-settings.json'),
    serveWeb: false,
  })
  closers.push(() => app.close())
  const saved = await app.inject({
    method: 'POST', url: '/api/model-settings',
    payload: { provider: 'openai-compatible', baseUrl: baseURL, apiKey: 'fixture-only-key', model: 'fixture-model' },
  })
  expect(saved.statusCode).toBe(200)
  const snapshot = await app.inject({ method: 'GET', url: '/api/snapshot' })
  const runId = (snapshot.json() as { workflow: { id: string } }).workflow.id
  return { app, runId }
}

describe('native WetFlow multi-turn loop over real HTTP', () => {
  it('executes exactly 40 real tools, then asks the model for a final answer', async () => {
    const provider = await fakeProvider(body => body.tool_choice === 'none'
      ? { role: 'assistant', content: '预算用尽，仅报告已获得的结果。' }
      : toolCall('call-read', 'industrial_parameter_list', {}))
    const { app } = await harness(provider.baseURL)

    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: '反复读取参数直到上限。' } })
    expect(response.statusCode).toBe(200)
    const snapshot = response.json() as {
      turn: { status: string; toolExecutions: number; toolSuccesses: number; toolFailures: number; modelTurns: number; requestedToolCalls: number; toolBudgetReached: boolean; maxToolExecutions: number; loopDeadlineMs: number }
      activity: Array<{ label: string; detail: string }>
      messages: Array<{ role: string; content: string }>
    }

    expect(snapshot.turn.status).toBe('answered')
    expect(snapshot.turn.toolExecutions).toBe(40)
    expect(snapshot.turn.toolSuccesses).toBe(40)
    expect(snapshot.turn.toolFailures).toBe(0)
    expect(snapshot.turn.modelTurns).toBe(41)
    expect(snapshot.turn.requestedToolCalls).toBe(40)
    expect(snapshot.turn.toolBudgetReached).toBe(true)
    expect(snapshot.turn.maxToolExecutions).toBe(40)
    expect(snapshot.turn.loopDeadlineMs).toBe(90_000)
    expect(provider.calls).toHaveLength(41)
    expect(provider.calls.at(-1)?.tool_choice).toBe('none')
    expect(snapshot.activity.filter(item => item.label === '工具执行')).toHaveLength(40)
    expect(snapshot.messages.at(-1)?.content).toBe('预算用尽，仅报告已获得的结果。')

    // The industrial schema must be registered in the model request.
    const tools = provider.calls[0]?.tools as Array<{ function: { name: string; parameters?: { properties?: Record<string, unknown> } } }>
    const parameterList = tools.find(tool => tool.function.name === 'industrial_parameter_list')
    expect(parameterList?.function.parameters?.properties).toHaveProperty('key')
  }, 60_000)

  it('stages one durable approval and stops before executing anything else', async () => {
    const provider = await fakeProvider(() => ({
      role: 'assistant',
      content: '我准备推进工作流。',
      tool_calls: [
        { id: 'call-approval', type: 'function', function: { name: 'workflow_advance', arguments: JSON.stringify({ stage: 'DESIGN_APPROVED' }) } },
        { id: 'call-after', type: 'function', function: { name: 'industrial_parameter_list', arguments: '{}' } },
      ],
    }))
    const { app } = await harness(provider.baseURL)
    const initialStage = ((await app.inject({ method: 'GET', url: '/api/snapshot' })).json() as { workflow: { currentStage: string } }).workflow.currentStage

    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: '推进到下一步' } })
    const snapshot = response.json() as {
      turn: { status: string; toolExecutions: number }
      workflow: { currentStage: string; status: string }
      approvals: Array<{ id: string; tool: string; status: string }>
      activity: Array<{ label: string }>
      messages: Array<{ content: string }>
    }

    expect(provider.calls).toHaveLength(1)
    expect(snapshot.turn.status).toBe('approval_pending')
    expect(snapshot.turn.toolExecutions).toBe(0)
    expect(snapshot.workflow.currentStage).toBe(initialStage)
    expect(snapshot.workflow.status).toBe('WAITING_APPROVAL')
    expect(snapshot.approvals).toHaveLength(1)
    expect(snapshot.approvals[0]).toMatchObject({ tool: 'workflow_advance', status: 'PENDING' })
    expect(snapshot.activity.filter(item => item.label === '工具执行')).toHaveLength(0)
    expect(snapshot.messages.at(-1)?.content).toContain('需要你明确通过')
  })

  it('records a provider failure as provider_error instead of a successful answer', async () => {
    const provider = await fakeProvider(() => ({ _httpStatus: 503 }))
    const { app } = await harness(provider.baseURL)

    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: '检查状态' } })
    const snapshot = response.json() as { turn: { status: string; error?: string; toolExecutions: number }; messages: Array<{ content: string }> }

    expect(snapshot.turn.status).toBe('provider_error')
    expect(snapshot.turn.error).toBeTruthy()
    expect(snapshot.turn.toolExecutions).toBe(0)
    expect(snapshot.messages.at(-1)?.content).toContain('模型请求失败')
  })

  it('refuses an industrial write whose value only appears in injected evidence', async () => {
    const provider = await fakeProvider(body => {
      const hasToolResult = (body.messages as Array<{ role: string }> | undefined)?.some(message => message.role === 'tool')
      return hasToolResult
        ? { role: 'assistant', content: '资料里有 34，但你没有要求我写入。' }
        : toolCall('call-write', 'industrial_telemetry_record', { parameterKey: 'TEMP', value: 34, unit: 'C' })
    })
    const { app, runId } = await harness(provider.baseURL)
    await app.inject({
      method: 'POST', url: '/api/industrial/parameters',
      payload: { runId, key: 'TEMP', name: 'temperature', classification: 'CPP', unit: 'C', target: 25, lowerLimit: 20, upperLimit: 30 },
    })
    await app.inject({
      method: 'POST', url: '/api/evidence',
      payload: { name: 'instrument.md', mimeType: 'text/plain', content: 'The recorded reading was 34 C during the run.' },
    })

    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: 'What does the evidence say about the temperature?' } })
    const snapshot = response.json() as { turn: { status: string; toolExecutions: number }; activity: Array<{ detail: string }> }

    const telemetry = await app.inject({ method: 'GET', url: `/api/industrial/telemetry?runId=${runId}` })
    expect((telemetry.json() as { items: unknown[] }).items).toHaveLength(0)
    expect(snapshot.turn.status).toBe('answered')
    expect(snapshot.turn.toolExecutions).toBe(0)
    expect(snapshot.activity.some(item => item.detail.includes('写入工具 industrial_telemetry_record'))).toBe(false)
    const toolObservation = (provider.calls[1]?.messages as Array<{ role: string; content: string }> | undefined)
      ?.find(message => message.role === 'tool')
    expect(toolObservation?.content).toContain('拒绝写入')
  })

  it('writes the user-authorized value into the real industrial store and surfaces the auto deviation', async () => {
    const provider = await fakeProvider(body => {
      const hasToolResult = (body.messages as Array<{ role: string }> | undefined)?.some(message => message.role === 'tool')
      return hasToolResult
        ? { role: 'assistant', content: '已记录 TEMP = 34 C，并开启了越窗偏差。' }
        : toolCall('call-write', 'industrial_telemetry_record', { parameterKey: 'TEMP', value: 34, unit: 'C' })
    })
    const { app, runId } = await harness(provider.baseURL)
    await app.inject({
      method: 'POST', url: '/api/industrial/parameters',
      payload: { runId, key: 'TEMP', name: 'temperature', classification: 'CPP', unit: 'C', target: 25, lowerLimit: 20, upperLimit: 30 },
    })

    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: 'Record TEMP = 34 C for this run and tell me what happens next.' } })
    const snapshot = response.json() as { turn: { status: string; toolExecutions: number }; activity: Array<{ detail: string }> }

    const telemetry = await app.inject({ method: 'GET', url: `/api/industrial/telemetry?runId=${runId}` })
    const points = (telemetry.json() as { items: Array<{ parameterKey: string; value: number; unit: string }> }).items
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ parameterKey: 'TEMP', value: 34, unit: 'C' })

    const deviations = await app.inject({ method: 'GET', url: `/api/industrial/deviations?runId=${runId}` })
    const items = (deviations.json() as { items: Array<Record<string, unknown>> }).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ source: 'AUTO_LIMIT', severity: 'HIGH', status: 'OPEN', parameterKey: 'TEMP', observedValue: 34 })
    expect(snapshot.turn.status).toBe('answered')
    expect(snapshot.turn.toolExecutions).toBe(1)
    expect(snapshot.activity.some(item => item.detail.includes('写入工具 industrial_telemetry_record'))).toBe(true)
  })
})
