import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from '../src/server.js'

const temporary: string[] = []

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('WetFlow HTTP surface', () => {
  it('imports local text evidence without exposing its raw content in list responses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-evidence-api-'))
    temporary.push(dir)
    const app = await createServer({ dbPath: join(dir, 'wetflow.db'), serveWeb: false })
    try {
      const imported = await app.inject({
        method: 'POST', url: '/api/evidence',
        payload: {
          name: 'fermentation-notes.md',
          mimeType: 'text/markdown',
          content: '# 发酵记录\nA07 在 30°C 条件下的 PYC 检测值为 12.4 mg/L。',
        },
      })
      expect(imported.statusCode).toBe(200)
      expect(imported.json()).toMatchObject({ name: 'fermentation-notes.md', chunkCount: 1 })

      const listed = await app.inject({ method: 'GET', url: '/api/evidence' })
      expect(listed.statusCode).toBe(200)
      expect(listed.json().items).toEqual([expect.objectContaining({ name: 'fermentation-notes.md', chunkCount: 1 })])
      expect(listed.body).not.toContain('12.4 mg/L')

      const answer = await app.inject({
        method: 'POST', url: '/api/chat', payload: { content: '根据资料查找 A07 的 PYC 检测值' },
      })
      expect(answer.statusCode).toBe(200)
      expect(answer.json().messages.at(-1).content).toContain('[证据: fermentation-notes.md#1]')
      // Local answering still reads and cites imported text without any cloud consent.
      expect(answer.json().context).toMatchObject({ evidenceSources: 0, evidenceChunks: 0 })
    } finally {
      await app.close()
    }
  })

  it('creates projects and workflow runs with isolated active context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-workspace-api-'))
    temporary.push(dir)
    const app = await createServer({ dbPath: join(dir, 'wetflow.db'), serveWeb: false })
    try {
      const initial = await app.inject({ method: 'GET', url: '/api/workspace' })
      expect(initial.statusCode).toBe(200)
      expect(initial.json()).toMatchObject({
        projects: [{ runCount: 1 }],
        runs: [{ id: 'wf-demo' }],
        activeWorkflowRunId: 'wf-demo',
      })

      const createdProject = await app.inject({
        method: 'POST', url: '/api/projects', payload: { name: '  新菌株项目  ' },
      })
      expect(createdProject.statusCode).toBe(200)
      expect(createdProject.json().workflow).toMatchObject({ project: '新菌株项目', currentStage: 'DRAFT' })
      expect(createdProject.json().messages).toEqual([])
      const projectRunId = createdProject.json().workflow.id as string

      const createdRun = await app.inject({
        method: 'POST', url: '/api/workflow-runs',
        payload: { projectId: createdProject.json().workflow.projectId, name: '补充验证' },
      })
      expect(createdRun.statusCode).toBe(200)
      expect(createdRun.json().workflow).toMatchObject({ name: '补充验证', currentStage: 'DRAFT' })
      expect(createdRun.json().workflow.id).not.toBe(projectRunId)

      const restored = await app.inject({
        method: 'POST', url: `/api/workflow-runs/${projectRunId}/activate`, payload: {},
      })
      expect(restored.statusCode).toBe(200)
      expect(restored.json().workflow.id).toBe(projectRunId)
      expect(restored.json().context.workflowId).toBe(projectRunId)
      const workspace = await app.inject({ method: 'GET', url: '/api/workspace' })
      expect(workspace.json().projects).toHaveLength(2)
      expect(workspace.json().runs).toHaveLength(3)
      expect(workspace.json().activeWorkflowRunId).toBe(projectRunId)
    } finally {
      await app.close()
    }
  })

  it('creates and switches independent conversations while keeping workflow state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-conversations-'))
    temporary.push(dir)
    const app = await createServer({ dbPath: join(dir, 'wetflow.db'), serveWeb: false })
    try {
      const initial = await app.inject({ method: 'GET', url: '/api/conversations' })
      const initialBody = initial.json() as { activeId: string; items: Array<{ id: string }> }
      expect(initial.statusCode).toBe(200)
      expect(initialBody.items).toHaveLength(1)

      const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} })
      expect(created.statusCode).toBe(200)
      expect(created.json().messages).toEqual([])
      expect(created.json().workflow.currentStage).toBe('DESIGN_REVIEW')

      const list = await app.inject({ method: 'GET', url: '/api/conversations' })
      expect(list.json().items).toHaveLength(2)
      expect(list.json().activeId).not.toBe(initialBody.activeId)
      const createdId = list.json().activeId as string

      const renamed = await app.inject({
        method: 'PATCH', url: `/api/conversations/${createdId}`, payload: { title: '  发酵条件讨论  ' },
      })
      expect(renamed.statusCode).toBe(200)
      expect(renamed.json().title).toBe('发酵条件讨论')
      expect((await app.inject({ method: 'GET', url: '/api/conversations' })).json().items[0].title).toBe('发酵条件讨论')

      const emptyTitle = await app.inject({
        method: 'PATCH', url: `/api/conversations/${createdId}`, payload: { title: '   ' },
      })
      expect(emptyTitle.statusCode).toBe(400)
      expect(emptyTitle.json().error).toContain('不能为空')

      const restored = await app.inject({
        method: 'POST', url: `/api/conversations/${initialBody.activeId}/activate`, payload: {},
      })
      expect(restored.statusCode).toBe(200)
      expect(restored.json().messages.length).toBeGreaterThan(0)
      expect(restored.json().workflow.currentStage).toBe('DESIGN_REVIEW')

      const sent = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: '原始用户消息' } })
      const userMessage = sent.json().messages.find((message: { role: string; content: string }) => message.role === 'user' && message.content === '原始用户消息')
      const edited = await app.inject({
        method: 'PATCH', url: `/api/messages/${userMessage.id}`, payload: { content: ' 修改后的用户消息 ' },
      })
      expect(edited.statusCode).toBe(200)
      expect(edited.json().messages.find((message: { id: string }) => message.id === userMessage.id).content).toBe('修改后的用户消息')
      expect(edited.json().messages.at(-1).role).toBe('assistant')
      expect(edited.json().messages.at(-1).content).toContain('当前工作流')
      expect(edited.json().workflow.currentStage).toBe('DESIGN_REVIEW')

      const assistantMessage = edited.json().messages.find((message: { role: string }) => message.role === 'assistant')
      const forbidden = await app.inject({
        method: 'PATCH', url: `/api/messages/${assistantMessage.id}`, payload: { content: '不能编辑 Agent 回复' },
      })
      expect(forbidden.statusCode).toBe(400)
      expect(forbidden.json().error).toContain('只能编辑自己发送的消息')
    } finally {
      await app.close()
    }
  })

  it('serves compiled WebUI assets instead of falling back to HTML', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-cordis-web-'))
    temporary.push(dir)
    const app = await createServer({ dbPath: join(dir, 'wetflow.db') })
    try {
      const builtHtml = readFileSync(join(process.cwd(), 'dist/web/index.html'), 'utf8')
      const assetPath = builtHtml.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1]
      expect(assetPath).toBeTruthy()
      const asset = await app.inject({ method: 'GET', url: assetPath ?? '/assets/missing.js' })
      expect(asset.statusCode).toBe(200)
      expect(asset.headers['content-type']).not.toContain('text/html')
      if (assetPath?.endsWith('.js')) expect(asset.headers['content-type']).toContain('javascript')
    } finally {
      await app.close()
    }
  })

  it('serves one shared snapshot and drives approval through the API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-cordis-server-'))
    temporary.push(dir)
    const app = await createServer({ dbPath: join(dir, 'wetflow.db'), serveWeb: false })
    try {
      const health = await app.inject({ method: 'GET', url: '/health' })
      expect(health.json()).toEqual({ ok: true, framework: 'cordis', service: 'wetflow-agent' })
      const chat = await app.inject({ method: 'POST', url: '/api/chat', payload: { content: '推进到下一步' } })
      expect(chat.statusCode).toBe(200)
      const staged = chat.json() as { approvals: Array<{ id: string; status: string }>; workflow: { currentStage: string } }
      expect(staged.workflow.currentStage).toBe('DESIGN_REVIEW')
      const approval = staged.approvals.find(item => item.status === 'PENDING')
      const accepted = await app.inject({
        method: 'POST', url: `/api/approvals/${approval?.id ?? ''}`, payload: { decision: 'approve' },
      })
      expect(accepted.statusCode).toBe(200)
      expect(accepted.json().workflow.currentStage).toBe('DESIGN_APPROVED')
    } finally {
      await app.close()
    }
  })

  it('exposes a safe model catalog and rejects unsupported reasoning values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-model-settings-'))
    temporary.push(dir)
    const app = await createServer({ dbPath: join(dir, 'wetflow.db'), serveWeb: false })
    try {
      const catalog = await app.inject({ method: 'GET', url: '/api/models' })
      expect(catalog.statusCode).toBe(200)
      expect(catalog.json()).toMatchObject({
        enabled: false,
        defaultModel: 'builtin',
        defaultReasoningEffort: 'medium',
        models: [{ id: 'builtin', label: '内置 Agent' }],
      })
      expect(catalog.body).not.toContain('apiKey')

      const invalid = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { content: '检查状态', reasoningEffort: 'extreme' },
      })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json().error).toContain('reasoningEffort')
    } finally {
      await app.close()
    }
  })

  it('stores model settings locally without exposing the API key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-provider-settings-'))
    temporary.push(dir)
    const settingsPath = join(dir, 'model-settings.json')
    const app = await createServer({
      dbPath: join(dir, 'wetflow.db'),
      settingsPath,
      serveWeb: false,
    })
    try {
      const initial = await app.inject({ method: 'GET', url: '/api/model-settings' })
      expect(initial.json()).toMatchObject({
        provider: 'openai-compatible',
        configured: false,
        hasApiKey: false,
      })

      const saved = await app.inject({
        method: 'POST',
        url: '/api/model-settings',
        payload: {
          provider: 'openai-compatible',
          baseUrl: 'https://models.example.test/v1/',
          apiKey: 'local-test-secret',
          model: 'wetflow-test-model',
        },
      })
      expect(saved.statusCode).toBe(200)
      expect(saved.json()).toEqual({
        provider: 'openai-compatible',
        baseUrl: 'https://models.example.test/v1',
        model: 'wetflow-test-model',
        hasApiKey: true,
        configured: true,
      })
      expect(saved.body).not.toContain('local-test-secret')
      expect(readFileSync(settingsPath, 'utf8')).toContain('local-test-secret')

      const catalog = await app.inject({ method: 'GET', url: '/api/models' })
      expect(catalog.json()).toMatchObject({
        enabled: true,
        defaultModel: 'wetflow-test-model',
        models: [
          { id: 'wetflow-test-model', label: 'wetflow-test-model' },
          { id: 'builtin', label: '内置 Agent' },
        ],
      })

      const changedModel = await app.inject({
        method: 'POST',
        url: '/api/model-settings',
        payload: {
          provider: 'openai-compatible',
          baseUrl: 'https://models.example.test/v1',
          apiKey: '',
          model: 'wetflow-next-model',
        },
      })
      expect(changedModel.statusCode).toBe(200)
      expect(readFileSync(settingsPath, 'utf8')).toContain('local-test-secret')
      expect(changedModel.body).not.toContain('local-test-secret')
    } finally {
      await app.close()
    }
  })
})
