import { WetFlowStore } from '../src/core/store.js'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from '../src/server.js'
import { createCanvas } from '@napi-rs/canvas'
import { pdfFixture } from './fixtures/pdf.js'

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

async function harness(baseURL: string, legacyRoute = false) {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-native-integration-'))
  temporary.push(dir)
  if (legacyRoute) {
    const store = new WetFlowStore(join(dir, 'wetflow.db'))
    store.setWorkflow({ currentStage: 'DESIGN_REVIEW', completedStages: ['DRAFT'] })
    store.close()
  }
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
  return { app, runId, dir }
}

describe('Education WEAVE over the provider HTTP boundary', () => {
  it('sends the plugin framework on every tool-loop request and stops after unload', async () => {
    const provider = await fakeProvider((_body, call) => call === 1
      ? toolCall('education-search', 'education_search_cases', { category: 'storytelling', audience: 'primary' })
      : call === 2 ? toolCall('education-brief', 'education_make_brief', {
        audience: 'primary', durationMinutes: 30, learningGoal: 'Explain one environmental choice in a picture-book story',
        resources: ['picture book'], caseIds: ['nnu-rainbow-orchard'],
      }) : { role: 'assistant', content: 'fixture plan' })
    const { app } = await harness(provider.baseURL)
    await app.inject({ method: 'PATCH', url: '/api/privacy-settings', payload: { allowDocumentExcerpts: true } })
    const loaded = await app.inject({ method: 'POST', url: '/api/plugins/education/load' })
    expect(loaded.statusCode).toBe(200)
    const catalogue = (await app.inject('/api/education/library')).json()
    expect(catalogue.categories).toHaveLength(6)
    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: '给小学生安排30分钟的绘本活动' } })
    expect(response.statusCode).toBe(200)
    expect(provider.calls).toHaveLength(3)
    for (const body of provider.calls) {
      const messages = body.messages as Array<{ role: string; content: string }>
      expect(messages[0]?.role).toBe('system')
      expect(messages[0]?.content).toContain('Education 插件已启用')
      for (const word of ['Wonder（思索）', 'Explore（探索）', 'Action（落地）', 'Verify（核验）', 'Echo（回响）']) expect(messages[0]?.content).toContain(word)
    }
    const last = provider.calls[2]!.messages as Array<{ role: string; content: string }>
    const brief = JSON.parse(last.filter(message => message.role === 'tool').at(-1)!.content)
    expect(brief.weaveCycle).toHaveLength(5)
    expect(brief.comparisons[0].source.citations.length).toBeGreaterThan(0)
    expect(brief.comparisons[0].sourceStatus).toBe('published_resource')
    await app.inject({ method: 'POST', url: '/api/plugins/education/unload' })
    await app.inject({ method: 'POST', url: '/api/chat', payload: { content: '查看项目状态' } })
    const after = provider.calls.at(-1)!.messages as Array<{ content: string }>
    expect(after[0]?.content).not.toContain('Education 插件已启用')
    expect((await app.inject('/api/education/library')).statusCode).toBe(409)
  })
})

describe('local files and multimodal input over real HTTP', () => {
  it('passes uploaded PDF text and page citations through the actual tool loop', async () => {
    let path = ''
    const provider = await fakeProvider((_body, call) => call === 1
      ? toolCall('read-pdf', 'local_file_read', { path, mode: 'text' })
      : { role: 'assistant', content: '已核对第 1 页。' })
    const { app } = await harness(provider.baseURL)
    await app.inject({ method: 'PATCH', url: '/api/privacy-settings', payload: { allowDocumentExcerpts: true } })
    const uploaded = await app.inject({ method: 'POST', url: '/api/attachments',
      payload: { name: 'feed-report.pdf', dataUrl: `data:application/pdf;base64,${pdfFixture(['Measured value 21.3 wt%', 'Second page']).toString('base64')}` } })
    expect(uploaded.statusCode).toBe(200)
    const attachment = uploaded.json() as { id: string; path: string }
    path = attachment.path
    const reply = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: '读 PDF 第 1 页', attachmentIds: [attachment.id] } })
    expect(reply.statusCode).toBe(200)
    expect(reply.json().turn.toolSuccesses).toBe(1)
    const messages = provider.calls[1]!.messages as Array<{ role: string; content: string }>
    const result = JSON.parse(messages.find(message => message.role === 'tool')!.content)
    expect(result.text).toContain('21.3 wt%')
    expect(result.citation).toBe('[文件: feed-report.pdf#p1]')
    expect(result.next).toEqual({ page: 2, offset: 0 })
    const schemas = provider.calls[0]!.tools as Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>
    expect(schemas.find(tool => tool.function.name === 'local_file_read')!.function.parameters.properties).toHaveProperty('mode')
  })

  it('preserves image attachments across reload and follow-up, and respects revoked consent', async () => {
    const provider = await fakeProvider(() => ({ role: 'assistant', content: '图片已收到。' }))
    const { app, dir } = await harness(provider.baseURL)
    await app.inject({ method: 'PATCH', url: '/api/privacy-settings', payload: { allowDocumentExcerpts: true } })
    const canvas = createCanvas(64, 64)
    canvas.getContext('2d').fillRect(0, 0, 32, 32)
    const uploaded = await app.inject({ method: 'POST', url: '/api/attachments',
      payload: { name: '截图.png', dataUrl: `data:image/png;base64,${(await canvas.encode('png')).toString('base64')}` } })
    expect(uploaded.statusCode).toBe(200)
    const attachment = uploaded.json() as { id: string }
    expect((await app.inject({ method: 'GET', url: `/api/attachments/${attachment.id}` })).headers['content-type']).toBe('image/png')
    const reply = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: '看图', attachmentIds: [attachment.id] } })
    expect(reply.json().turn.status).toBe('answered')
    const imageMessages = (call: number) => (provider.calls[call]!.messages as Array<{ content: unknown }>).flatMap(message => Array.isArray(message.content) ? message.content : [])
    expect(imageMessages(0).find(part => part.type === 'image_url').image_url.url).toMatch(/^data:image\/jpeg;base64,/)
    await app.close()
    const reopened = await createServer({ dbPath: join(dir, 'wetflow.db'), industrialDbPath: join(dir, 'industrial.db'),
      industrialSettingsPath: join(dir, 'industrial-settings.json'), settingsPath: join(dir, 'model-settings.json'), serveWeb: false })
    closers.push(() => reopened.close())
    const snapshot = (await reopened.inject({ method: 'GET', url: '/api/snapshot' })).json()
    expect(snapshot.messages.find((message: { role: string }) => message.role === 'user').attachments[0].id).toBe(attachment.id)
    await reopened.inject({ method: 'POST', url: '/api/chat', payload: { content: '再看一下上一张图' } })
    expect(imageMessages(1).some(part => part.type === 'image_url')).toBe(true)
    await reopened.inject({ method: 'PATCH', url: '/api/privacy-settings', payload: { allowDocumentExcerpts: false } })
    const blocked = await reopened.inject({ method: 'POST', url: '/api/chat', payload: { content: '图片', attachmentIds: [attachment.id] } })
    expect(blocked.statusCode).toBe(400)
    await reopened.inject({ method: 'POST', url: '/api/chat', payload: { content: '只回答这句文字' } })
    expect(imageMessages(2).some(part => part.type === 'image_url')).toBe(false)
    expect(JSON.stringify(provider.calls[2])).not.toContain(attachment.id)
  })

  it('sends actual PDF page images after all parallel tool responses without base64 truncation', async () => {
    let path = ''
    const provider = await fakeProvider((_body, call) => call === 1 ? {
      role: 'assistant', content: '', tool_calls: [
        { id: 'read-image', type: 'function', function: { name: 'local_file_read', arguments: JSON.stringify({ path, mode: 'image' }) } },
        { id: 'read-state', type: 'function', function: { name: 'workflow_status', arguments: '{}' } },
      ],
    } : { role: 'assistant', content: 'PDF 页面已查看。' })
    const { app, dir } = await harness(provider.baseURL)
    path = join(dir, 'chart.pdf')
    writeFileSync(path, pdfFixture(['Chart caption']))
    await app.inject({ method: 'PATCH', url: '/api/privacy-settings', payload: { allowDocumentExcerpts: true } })
    const reply = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: `查看 ${path}` } })
    expect(reply.json().turn.toolSuccesses).toBe(2)
    const messages = provider.calls[1]!.messages as Array<{ role: string; content: any; tool_call_id?: string; tool_calls?: unknown[] }>
    const index = messages.findIndex(message => message.role === 'assistant' && message.tool_calls?.length)
    expect(messages.slice(index + 1, index + 4).map(message => message.role)).toEqual(['tool', 'tool', 'user'])
    expect(messages[index + 1]!.tool_call_id).toBe('read-image')
    expect(messages[index + 2]!.tool_call_id).toBe('read-state')
    expect(messages[index + 1]!.content).not.toContain('base64')
    const image = messages[index + 3]!.content.find((part: { type: string }) => part.type === 'image_url')
    expect(image.image_url.url).toMatch(/^data:image\/jpeg;base64,/)
    expect(image.image_url.url).not.toContain('截断')
  })

  it('does not execute local file reads when document sharing is disabled', async () => {
    const provider = await fakeProvider((_body, call) => call === 1
      ? toolCall('blocked', 'local_file_read', { path: '/definitely/not/read.txt' })
      : { role: 'assistant', content: '请开启资料发送。' })
    const { app } = await harness(provider.baseURL)
    const reply = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: '读取本地文件' } })
    expect(reply.json().turn.toolExecutions).toBe(0)
    expect(JSON.stringify(provider.calls[1])).toContain('请先')
    const tooMany = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: '看图', attachmentIds: ['1', '2', '3', '4', '5'] } })
    expect(tooMany.statusCode).toBe(400)
  })
})

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
    const { app } = await harness(provider.baseURL, true)
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
