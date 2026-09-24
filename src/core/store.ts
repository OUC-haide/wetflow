import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  WORKFLOW_STAGES,
  type ActivityEvent,
  type AgentEvent,
  type ApprovalRequest,
  type ChatMessage,
  type ConversationMemory,
  type ConversationSummary,
  type EvidenceChunk,
  type EvidenceSource,
  type ProjectSummary,
  type ToolProposal,
  type WorkflowRunSummary,
  type WorkflowSnapshot,
  type WorkflowStageKey,
  type WorkspaceCatalog,
} from './types.js'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string => `${prefix}-${crypto.randomUUID().slice(0, 8)}`
const MAX_EVIDENCE_BYTES = 2_000_000

function evidenceChunks(content: string, targetSize = 1_200, overlap = 160): string[] {
  const normalized = content.replace(/\r\n?/g, '\n').trim()
  const chunks: string[] = []
  let start = 0
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + targetSize)
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf('\n', end), normalized.lastIndexOf(' ', end))
      if (boundary > start + Math.floor(targetSize * 0.55)) end = boundary
    }
    const chunk = normalized.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= normalized.length) break
    start = Math.max(start + 1, end - overlap)
  }
  return chunks
}

function searchTerms(value: string): string[] {
  const normalized = value.toLowerCase()
  const terms: string[] = [...(normalized.match(/[a-z0-9_][a-z0-9_.-]+/g) ?? [])]
  const han = [...normalized].filter(character => /\p{Script=Han}/u.test(character))
  for (let index = 0; index < han.length - 1; index += 1) terms.push(`${han[index]}${han[index + 1]}`)
  if (han.length === 1 && han[0]) terms.push(han[0])
  return [...new Set(terms.filter(term => term.length > 1 || /\p{Script=Han}/u.test(term)))]
}

function citationName(value: string): string {
  return value.replace(/[\[\]#]/g, '_')
}

export class WetFlowStore {
  readonly events = new EventEmitter()
  private readonly db: DatabaseSync
  private transactionEvents: AgentEvent[] | undefined

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
    this.seedWorkspace()
    this.ensureConversation()
    this.backfillContextOwnership()
    this.seedWelcomeMessage()
  }

  close(): void {
    this.db.close()
  }

  workflow(): WorkflowSnapshot {
    return this.workflowForRun(this.activeWorkflowRunId())
  }

  workflowForRun(workflowRunId: string): WorkflowSnapshot {
    const row = this.db.prepare(`SELECT workflow_runs.*, projects.name AS project_name
      FROM workflow_runs JOIN projects ON projects.id = workflow_runs.project_id
      WHERE workflow_runs.id = ?`).get(workflowRunId) as Record<string, unknown> | undefined
    if (!row) throw new Error('工作流运行不存在。')
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      name: String(row.name),
      project: String(row.project_name),
      revision: Number(row.revision ?? 0),
      currentStage: String(row.current_stage) as WorkflowStageKey,
      status: String(row.status) as WorkflowSnapshot['status'],
      ...(row.wake_at ? { wakeAt: String(row.wake_at) } : {}),
      ...(row.pause_reason ? { pauseReason: String(row.pause_reason) } : {}),
      updatedAt: String(row.updated_at),
      completedStages: JSON.parse(String(row.completed_stages)) as WorkflowStageKey[],
    }
  }

  dueWorkflowRunIds(at: Date): string[] {
    return (this.db.prepare(`SELECT id FROM workflow_runs
      WHERE status = 'PAUSED' AND wake_at IS NOT NULL AND wake_at <= ? ORDER BY wake_at`).all(at.toISOString()) as Array<{ id: string }>)
      .map(row => row.id)
  }

  wakeWorkflowRun(workflowRunId: string): WorkflowSnapshot {
    return this.transaction(() => {
      const current = this.workflowForRun(workflowRunId)
      if (current.status !== 'PAUSED') return current
      const updatedAt = now()
      const next: WorkflowSnapshot = {
        ...current,
        revision: current.revision + 1,
        status: 'RUNNING',
        updatedAt,
      }
      delete next.wakeAt
      delete next.pauseReason
      this.db.prepare(`UPDATE workflow_runs SET revision = ?, status = 'RUNNING', wake_at = NULL,
        pause_reason = NULL, updated_at = ? WHERE id = ?`).run(next.revision, updatedAt, workflowRunId)
      this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(updatedAt, current.projectId)
      this.emit({ type: 'workflow', workflow: next })

      const conversation = this.db.prepare(`SELECT id FROM conversations WHERE workflow_run_id = ?
        ORDER BY updated_at DESC LIMIT 1`).get(workflowRunId) as { id: string } | undefined
      if (conversation) {
        const message: ChatMessage = {
          id: id('msg'), role: 'system', content: '已到设定时间，工作流自动唤醒。', createdAt: updatedAt,
        }
        this.db.prepare(`INSERT INTO messages (id, role, content, approval_id, created_at, conversation_id)
          VALUES (?, ?, ?, NULL, ?, ?)`).run(message.id, message.role, message.content, message.createdAt, conversation.id)
        this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(updatedAt, conversation.id)
        this.emit({ type: 'message', message })
      }
      const activity: ActivityEvent = {
        id: id('event'), type: 'wake', label: '定时自动唤醒', detail: `原定唤醒时间：${current.wakeAt}`, createdAt: updatedAt,
      }
      this.db.prepare(`INSERT INTO activity (id, workflow_run_id, type, label, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(activity.id, workflowRunId, activity.type, activity.label, activity.detail, activity.createdAt)
      this.emit({ type: 'activity', activity })
      return next
    })
  }

  messages(limit = 100): ChatMessage[] {
    // Timestamps can move backwards when the system clock is adjusted. rowid
    // preserves the actual conversation order in that case as well as on ties.
    const rows = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT ?')
      .all(this.activeConversationId(), limit) as Array<Record<string, unknown>>
    return rows.reverse().map(row => ({
      id: String(row.id), role: String(row.role) as ChatMessage['role'], content: String(row.content),
      createdAt: String(row.created_at), ...(row.approval_id ? { approvalId: String(row.approval_id) } : {}),
    }))
  }

  messagesForContext(): ChatMessage[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid')
      .all(this.activeConversationId()) as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: String(row.id), role: String(row.role) as ChatMessage['role'], content: String(row.content),
      createdAt: String(row.created_at), ...(row.approval_id ? { approvalId: String(row.approval_id) } : {}),
    }))
  }

  conversations(): ConversationSummary[] {
    return (this.db.prepare('SELECT * FROM conversations WHERE workflow_run_id = ? ORDER BY updated_at DESC')
      .all(this.activeWorkflowRunId()) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      workflowRunId: String(row.workflow_run_id),
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }))
  }

  projects(): ProjectSummary[] {
    return (this.db.prepare(`SELECT projects.*, COUNT(workflow_runs.id) AS run_count
      FROM projects LEFT JOIN workflow_runs ON workflow_runs.project_id = projects.id
      GROUP BY projects.id ORDER BY projects.updated_at DESC`).all() as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      name: String(row.name),
      runCount: Number(row.run_count),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }))
  }

  workflowRuns(projectId?: string): WorkflowRunSummary[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM workflow_runs WHERE project_id = ? ORDER BY updated_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM workflow_runs ORDER BY updated_at DESC').all()
    return (rows as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      projectId: String(row.project_id),
      name: String(row.name),
      currentStage: String(row.current_stage) as WorkflowRunSummary['currentStage'],
      status: String(row.status) as WorkflowRunSummary['status'],
      updatedAt: String(row.updated_at),
    }))
  }

  workspace(): WorkspaceCatalog {
    return {
      activeProjectId: this.activeProjectId(),
      activeWorkflowRunId: this.activeWorkflowRunId(),
      projects: this.projects(),
      runs: this.workflowRuns(),
    }
  }

  conversationMemory(keepRecentMessages = 8): ConversationMemory | undefined {
    const conversationId = this.activeConversationId()
    const rows = this.db.prepare(`SELECT rowid AS message_rowid, id, role, content FROM messages
      WHERE conversation_id = ? AND role != 'system' ORDER BY rowid`).all(conversationId) as Array<{
        message_rowid: number
        id: string
        role: ChatMessage['role']
        content: string
      }>
    const older = rows.slice(0, Math.max(0, rows.length - keepRecentMessages))
    if (older.length === 0) {
      this.db.prepare('DELETE FROM conversation_memories WHERE conversation_id = ?').run(conversationId)
      return undefined
    }

    const lines = older.map(message => {
      const role = message.role === 'user' ? '用户' : 'WetFlow'
      const content = message.content.replace(/\s+/g, ' ').trim()
      return `- ${role}：${content.slice(0, 280)}${content.length > 280 ? '…' : ''}`
    })
    const selected = lines.slice(0, Math.min(4, lines.length))
    let used = selected.join('\n').length
    for (let index = lines.length - 1; index >= 4; index -= 1) {
      const line = lines[index]
      if (!line || selected.includes(line)) continue
      if (used + line.length + 1 > 4_800) break
      selected.splice(Math.min(4, selected.length), 0, line)
      used += line.length + 1
    }
    const omitted = older.length - selected.length
    const content = [
      `长期记忆：共压缩 ${older.length} 条早期消息${omitted > 0 ? `，其中 ${omitted} 条仅保留计数` : ''}。`,
      '以下是提取式记录，事实仍以工作流状态和原始证据为准：',
      ...selected,
    ].join('\n')
    const throughMessageId = older.at(-1)?.id
    const existing = this.db.prepare('SELECT * FROM conversation_memories WHERE conversation_id = ?')
      .get(conversationId) as Record<string, unknown> | undefined
    if (existing && String(existing.through_message_id ?? '') === (throughMessageId ?? '')
      && Number(existing.message_count) === older.length && String(existing.content) === content) {
      return {
        conversationId,
        ...(throughMessageId ? { throughMessageId } : {}),
        messageCount: older.length,
        content,
        updatedAt: String(existing.updated_at),
      }
    }
    const updatedAt = now()
    this.db.prepare(`INSERT INTO conversation_memories
      (conversation_id, through_message_id, message_count, content, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET through_message_id = excluded.through_message_id,
      message_count = excluded.message_count, content = excluded.content, updated_at = excluded.updated_at`)
      .run(conversationId, throughMessageId ?? null, older.length, content, updatedAt)
    return { conversationId, ...(throughMessageId ? { throughMessageId } : {}), messageCount: older.length, content, updatedAt }
  }

  evidenceSources(): EvidenceSource[] {
    return (this.db.prepare(`SELECT evidence_sources.*, COUNT(evidence_chunks.id) AS chunk_count
      FROM evidence_sources LEFT JOIN evidence_chunks ON evidence_chunks.source_id = evidence_sources.id
      WHERE evidence_sources.workflow_run_id = ? GROUP BY evidence_sources.id
      ORDER BY evidence_sources.updated_at DESC`).all(this.activeWorkflowRunId()) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      workflowRunId: String(row.workflow_run_id),
      name: String(row.name),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes),
      chunkCount: Number(row.chunk_count),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }))
  }

  addEvidenceSource(name: string, content: string, mimeType = 'text/plain'): EvidenceSource {
    const normalizedName = name.replace(/\s+/g, ' ').trim()
    if (!normalizedName) throw new Error('资料名称不能为空。')
    if (normalizedName.length > 180) throw new Error('资料名称不能超过 180 个字符。')
    if (!content.trim()) throw new Error('资料内容为空。')
    if (content.includes('\0')) throw new Error('当前只支持文本资料。')
    const sizeBytes = Buffer.byteLength(content, 'utf8')
    if (sizeBytes > MAX_EVIDENCE_BYTES) throw new Error('单个资料不能超过 2 MB。')
    const workflowRunId = this.activeWorkflowRunId()
    const totals = this.db.prepare(`SELECT COUNT(*) AS source_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
      FROM evidence_sources WHERE workflow_run_id = ?`).get(workflowRunId) as { source_count: number; total_bytes: number }
    if (totals.source_count >= 100) throw new Error('当前运行最多保存 100 份资料。')
    if (Number(totals.total_bytes) + sizeBytes > 20_000_000) throw new Error('当前运行的本地资料总量不能超过 20 MB。')
    const chunks = evidenceChunks(content)
    if (chunks.length === 0) throw new Error('资料中没有可索引的文本。')
    const createdAt = now()
    const source: EvidenceSource = {
      id: id('source'), workflowRunId, name: normalizedName, mimeType: mimeType.slice(0, 120) || 'text/plain',
      sizeBytes, chunkCount: chunks.length, createdAt, updatedAt: createdAt,
    }
    this.transaction(() => {
      this.db.prepare(`INSERT INTO evidence_sources
        (id, workflow_run_id, name, mime_type, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(source.id, source.workflowRunId, source.name, source.mimeType, source.sizeBytes, source.createdAt, source.updatedAt)
      const insert = this.db.prepare('INSERT INTO evidence_chunks (id, source_id, ordinal, content) VALUES (?, ?, ?, ?)')
      chunks.forEach((chunk, ordinal) => insert.run(id('chunk'), source.id, ordinal, chunk))
      this.addActivity('evidence', '导入本地资料', `${source.name} · ${source.chunkCount} 个片段`)
    })
    return source
  }

  searchEvidence(query: string, limit = 4): EvidenceChunk[] {
    const terms = searchTerms(query)
    if (terms.length === 0) return []
    const rows = this.db.prepare(`SELECT evidence_chunks.*, evidence_sources.name AS source_name
      FROM evidence_chunks JOIN evidence_sources ON evidence_sources.id = evidence_chunks.source_id
      WHERE evidence_sources.workflow_run_id = ?`).all(this.activeWorkflowRunId()) as Array<Record<string, unknown>>
    return rows.map(row => {
      const content = String(row.content)
      const sourceName = String(row.source_name)
      const haystack = `${sourceName}\n${content}`.toLowerCase()
      const name = sourceName.toLowerCase()
      let score = 0
      for (const term of terms) {
        const occurrences = Math.min(3, haystack.split(term).length - 1)
        score += occurrences
        if (name.includes(term)) score += 3
      }
      const ordinal = Number(row.ordinal)
      return {
        id: String(row.id), sourceId: String(row.source_id), sourceName, ordinal, content,
        citation: `[证据: ${citationName(sourceName)}#${ordinal + 1}]`, score,
      }
    }).filter(chunk => chunk.score > 0)
      .sort((left, right) => right.score - left.score || left.ordinal - right.ordinal)
      .slice(0, Math.max(1, Math.min(12, limit)))
  }

  activeProjectId(): string {
    const row = this.db.prepare('SELECT project_id FROM workflow_runs WHERE id = ?')
      .get(this.activeWorkflowRunId()) as { project_id: string }
    return row.project_id
  }

  activeWorkflowRunId(): string {
    const state = this.db.prepare("SELECT value FROM app_state WHERE key = 'active_workflow_run_id'").get() as { value: string } | undefined
    if (state && this.db.prepare('SELECT 1 FROM workflow_runs WHERE id = ?').get(state.value)) return state.value
    const existing = this.db.prepare('SELECT id FROM workflow_runs ORDER BY updated_at DESC LIMIT 1').get() as { id: string } | undefined
    if (!existing) throw new Error('没有可用的工作流运行。')
    this.setActiveWorkflowRun(existing.id)
    return existing.id
  }

  activeConversationId(): string {
    const state = this.db.prepare("SELECT value FROM app_state WHERE key = 'active_conversation_id'").get() as { value: string } | undefined
    if (state && this.db.prepare('SELECT 1 FROM conversations WHERE id = ? AND workflow_run_id = ?')
      .get(state.value, this.activeWorkflowRunId())) return state.value
    return this.ensureConversation()
  }

  createConversation(title = '新对话'): ConversationSummary {
    const createdAt = now()
    const conversation: ConversationSummary = {
      id: id('chat'), workflowRunId: this.activeWorkflowRunId(), title, createdAt, updatedAt: createdAt,
    }
    this.transaction(() => {
      this.db.prepare('INSERT INTO conversations (id, workflow_run_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(conversation.id, conversation.workflowRunId, conversation.title, conversation.createdAt, conversation.updatedAt)
      this.setActiveConversation(conversation.id)
      this.addActivity('message', '新建对话', '已开启一段不继承历史消息的新对话')
    })
    return conversation
  }

  activateConversation(conversationId: string): ConversationSummary {
    const conversation = this.conversations().find(item => item.id === conversationId)
    if (!conversation) throw new Error('对话不存在。')
    this.setActiveConversation(conversationId)
    return conversation
  }

  createProject(name: string): ProjectSummary {
    const normalized = this.normalizedName(name, '项目名称')
    const createdAt = now()
    const projectId = id('project')
    this.transaction(() => {
      this.db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(projectId, normalized, createdAt, createdAt)
      this.createWorkflowRun('实验流程', projectId)
    })
    return this.projects().find(item => item.id === projectId) as ProjectSummary
  }

  createWorkflowRun(name: string, projectId = this.activeProjectId()): WorkflowRunSummary {
    const normalized = this.normalizedName(name, '运行名称')
    const project = this.db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined
    if (!project) throw new Error('项目不存在。')
    const createdAt = now()
    const run: WorkflowRunSummary = {
      id: id('run'), projectId, name: normalized, currentStage: 'DRAFT', status: 'RUNNING', updatedAt: createdAt,
    }
    this.transaction(() => {
      this.db.prepare(`INSERT INTO workflow_runs
        (id, project_id, name, project, current_stage, status, wake_at, pause_reason, completed_stages, updated_at, revision)
        VALUES (?, ?, ?, ?, 'DRAFT', 'RUNNING', NULL, NULL, '[]', ?, 0)`)
        .run(run.id, projectId, run.name, project.name, createdAt)
      this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(createdAt, projectId)
      this.setActiveWorkflowRun(run.id)
      this.ensureConversation()
      this.addActivity('workflow', '新建工作流运行', `${project.name} · ${run.name}`)
    })
    return run
  }

  activateWorkflowRun(workflowRunId: string): WorkflowRunSummary {
    const run = this.workflowRuns().find(item => item.id === workflowRunId)
    if (!run) throw new Error('工作流运行不存在。')
    this.setActiveWorkflowRun(workflowRunId)
    this.ensureConversation()
    return run
  }

  renameConversation(conversationId: string, title: string): ConversationSummary {
    const normalized = title.replace(/\s+/g, ' ').trim()
    if (!normalized) throw new Error('对话标题不能为空。')
    if (normalized.length > 80) throw new Error('对话标题不能超过 80 个字符。')
    const updatedAt = now()
    const result = this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND workflow_run_id = ?')
      .run(normalized, updatedAt, conversationId, this.activeWorkflowRunId())
    if (Number(result.changes) !== 1) throw new Error('对话不存在。')
    return this.conversations().find(item => item.id === conversationId) as ConversationSummary
  }

  approvals(): ApprovalRequest[] {
    return (this.db.prepare('SELECT * FROM approvals WHERE workflow_run_id = ? ORDER BY created_at DESC')
      .all(this.activeWorkflowRunId()) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      conversationId: String(row.conversation_id ?? this.activeConversationId()),
      workflowRunId: String(row.workflow_run_id ?? this.activeWorkflowRunId()),
      workflowRevision: Number(row.workflow_revision ?? this.workflow().revision),
      title: String(row.title), summary: String(row.summary), tool: String(row.tool),
      risk: String(row.risk) as ApprovalRequest['risk'], status: String(row.status) as ApprovalRequest['status'],
      createdAt: String(row.created_at), ...(row.resolved_at ? { resolvedAt: String(row.resolved_at) } : {}),
    }))
  }

  activity(limit = 50): ActivityEvent[] {
    return (this.db.prepare('SELECT * FROM activity WHERE workflow_run_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(this.activeWorkflowRunId(), limit) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id), type: String(row.type) as ActivityEvent['type'], label: String(row.label),
      detail: String(row.detail), createdAt: String(row.created_at),
    }))
  }

  addMessage(role: ChatMessage['role'], content: string, approvalId?: string): ChatMessage {
    const message: ChatMessage = { id: id('msg'), role, content, createdAt: now(), ...(approvalId ? { approvalId } : {}) }
    const conversationId = this.activeConversationId()
    this.db.prepare('INSERT INTO messages (id, role, content, approval_id, created_at, conversation_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(message.id, role, content, approvalId ?? null, message.createdAt, conversationId)
    const conversation = this.db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string }
    const title = role === 'user' && (conversation.title === '新对话' || conversation.title === '当前对话')
      ? content.replace(/\s+/g, ' ').trim().slice(0, 28) || conversation.title
      : conversation.title
    this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, message.createdAt, conversationId)
    this.emit({ type: 'message', message })
    this.addActivity('message', role === 'user' ? '用户消息' : 'Agent 回复', content.slice(0, 120))
    return message
  }

  rewindMessage(messageId: string, content: string): { message: ChatMessage; removedApprovalIds: string[] } {
    const normalized = content.trim()
    if (!normalized) throw new Error('消息内容不能为空。')
    if (normalized.length > 20_000) throw new Error('消息内容不能超过 20000 个字符。')
    const conversationId = this.activeConversationId()
    const row = this.db.prepare('SELECT rowid AS message_rowid, * FROM messages WHERE id = ? AND conversation_id = ?')
      .get(messageId, conversationId) as Record<string, unknown> | undefined
    if (!row) throw new Error('消息不存在或不属于当前对话。')
    if (row.role !== 'user') throw new Error('只能编辑自己发送的消息。')
    const stateChanged = this.db.prepare(`SELECT 1 FROM activity
      WHERE workflow_run_id = ? AND created_at >= ? AND type IN ('workflow', 'wake') LIMIT 1`)
      .get(this.activeWorkflowRunId(), String(row.created_at))
    const laterMessages = this.db.prepare(`SELECT approval_id FROM messages
      WHERE conversation_id = ? AND rowid > ? ORDER BY rowid`).all(conversationId, Number(row.message_rowid)) as Array<{ approval_id: string | null }>
    const removedApprovalIds = [...new Set(laterMessages.map(item => item.approval_id).filter((value): value is string => Boolean(value)))]
    const hasApprovedTool = removedApprovalIds.some(approvalId => {
      const approval = this.db.prepare('SELECT status FROM approvals WHERE id = ?').get(approvalId) as { status: string } | undefined
      return approval?.status === 'APPROVED'
    })
    if (stateChanged || hasApprovedTool) {
      throw new Error('这条消息之后工作流状态已经发生变更，不能重新生成；请新建对话后继续。')
    }
    const removedPending = removedApprovalIds.some(approvalId => {
      const approval = this.db.prepare('SELECT status FROM approvals WHERE id = ?').get(approvalId) as { status: string } | undefined
      return approval?.status === 'PENDING'
    })
    const updatedAt = now()
    this.transaction(() => {
      this.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(normalized, messageId)
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ? AND rowid > ?').run(conversationId, Number(row.message_rowid))
      for (const approvalId of removedApprovalIds) this.db.prepare('DELETE FROM approvals WHERE id = ?').run(approvalId)
      if (removedPending && !this.db.prepare("SELECT 1 FROM approvals WHERE workflow_run_id = ? AND status = 'PENDING' LIMIT 1")
        .get(this.activeWorkflowRunId())) {
        this.setWorkflow({ status: 'RUNNING' })
      }
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(updatedAt, conversationId)
      this.addActivity('message', '消息已重新提交', normalized.slice(0, 120))
    })
    const message: ChatMessage = {
      id: String(row.id),
      role: 'user',
      content: normalized,
      createdAt: String(row.created_at),
      ...(row.approval_id ? { approvalId: String(row.approval_id) } : {}),
    }
    this.emit({ type: 'message', message })
    return { message, removedApprovalIds }
  }

  createApproval(input: Omit<ApprovalRequest, 'id' | 'conversationId' | 'workflowRunId' | 'workflowRevision' | 'status' | 'createdAt'>, proposal: ToolProposal): ApprovalRequest {
    const workflowRevision = this.workflow().revision + 1
    const approval: ApprovalRequest = {
      ...input,
      id: id('approval'),
      conversationId: this.activeConversationId(),
      workflowRunId: this.activeWorkflowRunId(),
      workflowRevision,
      status: 'PENDING',
      createdAt: now(),
    }
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO approvals
        (id, conversation_id, workflow_run_id, workflow_revision, title, summary, tool, risk, status, created_at, resolved_at, proposal_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      ).run(
        approval.id, approval.conversationId, approval.workflowRunId, approval.workflowRevision, approval.title, approval.summary,
        approval.tool, approval.risk, approval.status, approval.createdAt, JSON.stringify(proposal),
      )
      this.emit({ type: 'approval', approval })
      this.addActivity('approval', '等待审批', approval.title)
      const workflow = this.setWorkflow({ status: 'WAITING_APPROVAL' })
      if (workflow.revision !== approval.workflowRevision) throw new Error('工作流版本写入失败。')
      return approval
    })
  }

  approvalProposal(approvalId: string): ToolProposal | undefined {
    const row = this.db.prepare('SELECT proposal_json FROM approvals WHERE id = ? AND workflow_run_id = ?')
      .get(approvalId, this.activeWorkflowRunId()) as { proposal_json: string | null } | undefined
    if (!row?.proposal_json) return undefined
    const parsed: unknown = JSON.parse(row.proposal_json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const value = parsed as Partial<ToolProposal>
    if (typeof value.tool !== 'string' || typeof value.title !== 'string' || typeof value.summary !== 'string') return undefined
    if (typeof value.payload !== 'object' || value.payload === null || Array.isArray(value.payload)) return undefined
    return value as ToolProposal
  }

  resolveApproval(approvalId: string, decision: 'APPROVED' | 'REJECTED'): ApprovalRequest {
    const resolvedAt = now()
    const result = this.db.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND workflow_run_id = ? AND status = 'PENDING'")
      .run(decision, resolvedAt, approvalId, this.activeWorkflowRunId())
    if (Number(result.changes) !== 1) throw new Error('审批不存在或已经处理。')
    const approval = this.approvals().find(item => item.id === approvalId)
    if (!approval) throw new Error('审批状态读取失败。')
    this.emit({ type: 'approval', approval })
    this.addActivity('approval', decision === 'APPROVED' ? '审批通过' : '审批拒绝', approval.title)
    const workflow = this.workflow()
    if (workflow.status === 'WAITING_APPROVAL' && workflow.revision === approval.workflowRevision) {
      this.setWorkflow({ status: 'RUNNING' })
    }
    return approval
  }

  setWorkflow(patch: Partial<Pick<WorkflowSnapshot, 'currentStage' | 'status' | 'completedStages'>> & {
    wakeAt?: string | null
    pauseReason?: string | null
  }): WorkflowSnapshot {
    const current = this.workflow()
    const wakeAt = patch.wakeAt === null ? undefined : patch.wakeAt ?? current.wakeAt
    const pauseReason = patch.pauseReason === null ? undefined : patch.pauseReason ?? current.pauseReason
    const { wakeAt: _wakeAt, pauseReason: _pauseReason, ...base } = current
    const next: WorkflowSnapshot = {
      ...base,
      revision: current.revision + 1,
      currentStage: patch.currentStage ?? current.currentStage,
      status: patch.status ?? current.status,
      completedStages: patch.completedStages ?? current.completedStages,
      ...(wakeAt ? { wakeAt } : {}),
      ...(pauseReason ? { pauseReason } : {}),
      updatedAt: now(),
    }
    this.db.prepare(`UPDATE workflow_runs SET revision = ?, current_stage = ?, status = ?, wake_at = ?, pause_reason = ?, completed_stages = ?, updated_at = ? WHERE id = ?`).run(
      next.revision, next.currentStage, next.status, next.wakeAt ?? null, next.pauseReason ?? null,
      JSON.stringify(next.completedStages), next.updatedAt, next.id,
    )
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(next.updatedAt, next.projectId)
    this.emit({ type: 'workflow', workflow: next })
    return next
  }

  advance(stage: WorkflowStageKey): WorkflowSnapshot {
    const current = this.workflow()
    const fromIndex = WORKFLOW_STAGES.findIndex(item => item.key === current.currentStage)
    const toIndex = WORKFLOW_STAGES.findIndex(item => item.key === stage)
    if (toIndex !== fromIndex + 1) throw new Error(`只能从 ${current.currentStage} 前进到下一阶段。`)
    const completedStages = [...current.completedStages, current.currentStage]
    const workflow = this.setWorkflow({ currentStage: stage, completedStages, status: stage === 'CLOSED' ? 'COMPLETED' : 'RUNNING' })
    this.addActivity('workflow', '工作流前进', `${current.currentStage} → ${stage}`)
    return workflow
  }

  addActivity(type: ActivityEvent['type'], label: string, detail: string): ActivityEvent {
    const activity: ActivityEvent = { id: id('event'), type, label, detail, createdAt: now() }
    this.db.prepare('INSERT INTO activity (id, workflow_run_id, type, label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(activity.id, this.activeWorkflowRunId(), type, label, detail, activity.createdAt)
    this.emit({ type: 'activity', activity })
    return activity
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionEvents) return operation()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionEvents = []
    try {
      const result = operation()
      this.db.exec('COMMIT')
      const events = this.transactionEvents
      this.transactionEvents = undefined
      for (const event of events) this.events.emit('event', event)
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.transactionEvents = undefined
      throw error
    }
  }

  private emit(event: AgentEvent): void {
    if (this.transactionEvents) this.transactionEvents.push(event)
    else this.events.emit('event', event)
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, project TEXT NOT NULL, current_stage TEXT NOT NULL,
        status TEXT NOT NULL, wake_at TEXT, pause_reason TEXT, completed_stages TEXT NOT NULL, updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, workflow_run_id TEXT, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, approval_id TEXT,
        created_at TEXT NOT NULL, conversation_id TEXT
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, tool TEXT NOT NULL,
        risk TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT,
        proposal_json TEXT, conversation_id TEXT, workflow_run_id TEXT, workflow_revision INTEGER
      );
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY, workflow_run_id TEXT, type TEXT NOT NULL, label TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_memories (
        conversation_id TEXT PRIMARY KEY, through_message_id TEXT, message_count INTEGER NOT NULL,
        content TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence_sources (
        id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence_chunks (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, ordinal INTEGER NOT NULL, content TEXT NOT NULL
      );
    `)
    const workflowColumns = this.db.prepare('PRAGMA table_info(workflow_runs)').all() as Array<{ name: string }>
    if (!workflowColumns.some(column => column.name === 'project_id')) {
      this.db.exec('ALTER TABLE workflow_runs ADD COLUMN project_id TEXT')
    }
    if (!workflowColumns.some(column => column.name === 'revision')) {
      this.db.exec('ALTER TABLE workflow_runs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
    }
    const approvalColumns = this.db.prepare('PRAGMA table_info(approvals)').all() as Array<{ name: string }>
    if (!approvalColumns.some(column => column.name === 'proposal_json')) {
      this.db.exec('ALTER TABLE approvals ADD COLUMN proposal_json TEXT')
    }
    if (!approvalColumns.some(column => column.name === 'conversation_id')) {
      this.db.exec('ALTER TABLE approvals ADD COLUMN conversation_id TEXT')
    }
    if (!approvalColumns.some(column => column.name === 'workflow_run_id')) {
      this.db.exec('ALTER TABLE approvals ADD COLUMN workflow_run_id TEXT')
    }
    if (!approvalColumns.some(column => column.name === 'workflow_revision')) {
      this.db.exec('ALTER TABLE approvals ADD COLUMN workflow_revision INTEGER')
    }
    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    if (!messageColumns.some(column => column.name === 'conversation_id')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN conversation_id TEXT')
    }
    const conversationColumns = this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    if (!conversationColumns.some(column => column.name === 'workflow_run_id')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN workflow_run_id TEXT')
    }
    const activityColumns = this.db.prepare('PRAGMA table_info(activity)').all() as Array<{ name: string }>
    if (!activityColumns.some(column => column.name === 'workflow_run_id')) {
      this.db.exec('ALTER TABLE activity ADD COLUMN workflow_run_id TEXT')
    }
    this.db.exec(`
      DROP INDEX IF EXISTS idx_approvals_single_pending;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_one_pending_per_run
      ON approvals(workflow_run_id) WHERE status = 'PENDING';
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_updated_at ON workflow_runs(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_conversations_run_updated_at ON conversations(workflow_run_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_run_created_at ON approvals(workflow_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_activity_run_created_at ON activity(workflow_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_evidence_sources_run_updated_at ON evidence_sources(workflow_run_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_evidence_chunks_source_ordinal ON evidence_chunks(source_id, ordinal);
      PRAGMA optimize;
    `)
  }

  private ensureConversation(): string {
    const workflowRunId = this.activeWorkflowRunId()
    this.db.prepare('UPDATE conversations SET workflow_run_id = ? WHERE workflow_run_id IS NULL').run(workflowRunId)
    const current = this.db.prepare("SELECT value FROM app_state WHERE key = 'active_conversation_id'").get() as { value: string } | undefined
    if (current && this.db.prepare('SELECT 1 FROM conversations WHERE id = ? AND workflow_run_id = ?')
      .get(current.value, workflowRunId)) return current.value
    const existing = this.db.prepare('SELECT id FROM conversations WHERE workflow_run_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(workflowRunId) as { id: string } | undefined
    const conversationId = existing?.id ?? id('chat')
    if (!existing) {
      const createdAt = now()
      this.db.prepare('INSERT INTO conversations (id, workflow_run_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(conversationId, workflowRunId, '当前对话', createdAt, createdAt)
    }
    this.db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id IS NULL').run(conversationId)
    this.setActiveConversation(conversationId)
    return conversationId
  }

  private setActiveConversation(conversationId: string): void {
    this.db.prepare(`INSERT INTO app_state (key, value) VALUES ('active_conversation_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(conversationId)
  }

  private setActiveWorkflowRun(workflowRunId: string): void {
    this.db.prepare(`INSERT INTO app_state (key, value) VALUES ('active_workflow_run_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(workflowRunId)
  }

  private seedWorkspace(): void {
    const updatedAt = now()
    const projectRows = this.db.prepare(`SELECT project, MAX(updated_at) AS latest_update FROM workflow_runs
      WHERE project IS NOT NULL GROUP BY project ORDER BY latest_update DESC`)
      .all() as Array<{ project: string }>
    if (projectRows.length === 0 && !(this.db.prepare('SELECT 1 FROM projects LIMIT 1').get())) {
      this.db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('project-demo', 'Aureobasidium A07', updatedAt, updatedAt)
    }
    for (const [index, row] of projectRows.entries()) {
      if (this.db.prepare('SELECT 1 FROM projects WHERE name = ?').get(row.project)) continue
      const preferredId = index === 0 && !this.db.prepare("SELECT 1 FROM projects WHERE id = 'project-demo'").get()
        ? 'project-demo'
        : id('project')
      this.db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(preferredId, row.project, updatedAt, updatedAt)
    }
    const fallbackProject = this.db.prepare('SELECT id, name FROM projects ORDER BY updated_at DESC LIMIT 1')
      .get() as { id: string; name: string }
    this.db.prepare(`UPDATE workflow_runs SET project_id = (
      SELECT projects.id FROM projects WHERE projects.name = workflow_runs.project LIMIT 1
    ) WHERE project_id IS NULL`).run()
    this.db.prepare('UPDATE workflow_runs SET project_id = ? WHERE project_id IS NULL').run(fallbackProject.id)
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get() as { n: number }
    if (count.n === 0) {
      this.db.prepare(`INSERT INTO workflow_runs
        (id, project_id, name, project, current_stage, status, wake_at, pause_reason, completed_stages, updated_at, revision)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0)`).run(
        'wf-demo', fallbackProject.id, 'PYC 来源筛选', fallbackProject.name, 'DESIGN_REVIEW', 'RUNNING', JSON.stringify(['DRAFT']), updatedAt,
      )
    }
    this.activeWorkflowRunId()
  }

  private seedWelcomeMessage(): void {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    if (count.n > 0) return
    this.addMessage('assistant', 'WetFlow 已就绪。你可以让我检查当前流程、生成工具提案，或暂停任务并设置唤醒时间。')
  }

  private backfillContextOwnership(): void {
    const conversationId = this.activeConversationId()
    const workflowRunId = this.activeWorkflowRunId()
    const workflowRevision = this.workflow().revision
    this.db.prepare('UPDATE approvals SET conversation_id = ? WHERE conversation_id IS NULL').run(conversationId)
    this.db.prepare('UPDATE approvals SET workflow_run_id = ? WHERE workflow_run_id IS NULL').run(workflowRunId)
    this.db.prepare('UPDATE approvals SET workflow_revision = ? WHERE workflow_revision IS NULL').run(workflowRevision)
    this.db.prepare('UPDATE activity SET workflow_run_id = ? WHERE workflow_run_id IS NULL').run(workflowRunId)
  }

  private normalizedName(value: string, label: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (!normalized) throw new Error(`${label}不能为空。`)
    if (normalized.length > 80) throw new Error(`${label}不能超过 80 个字符。`)
    return normalized
  }
}
