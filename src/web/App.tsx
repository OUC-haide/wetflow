import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowDown, ArrowUp, Bot, BrainCircuit, Check, ChevronDown, ChevronRight,
  Circle, Clock3, Database, FileText, FlaskConical, FolderKanban, GitBranch, History, KeyRound, LoaderCircle, Menu, MessageSquare, Moon, Paperclip, Pencil,
  PanelRight, Play, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Sun, Wrench, X,
  XCircle,
} from 'lucide-react'
import {
  WORKFLOW_STAGES,
  type AgentSnapshot,
  type ApprovalRequest,
  type ChatMessage,
  type EvidenceSource,
  type WorkspaceCatalog,
} from '../core/types.js'
import { ModelingWorkspace } from './ModelingWorkspace.js'
import { ResearchWorkspace } from './ResearchWorkspace.js'

const EMPTY: AgentSnapshot = {
  connected: false,
  agentState: 'READY',
  workflow: {
    id: '', projectId: '', name: '正在连接 WetFlow', project: 'WetFlow Agent', revision: 0, currentStage: 'DRAFT',
    status: 'RUNNING', updatedAt: new Date().toISOString(), completedStages: [],
  },
  context: {
    projectId: '', conversationId: '', workflowId: '', workflowRevision: 0, tokenBudget: 6_000,
    estimatedTokens: 0, memoryMessages: 0, evidenceSources: 0, evidenceChunks: 0,
    totalMessages: 0, selectedMessages: 0, omittedMessages: 0,
    generatedAt: new Date().toISOString(), sources: [],
  },
  approvals: [], messages: [], activity: [], tools: [], turn: null,
}

type ReasoningEffort = 'low' | 'medium' | 'high'

interface ModelCatalog {
  enabled: boolean
  models: Array<{ id: string; label: string }>
  defaultModel: string
  reasoningEfforts: Array<{ id: ReasoningEffort; label: string; description: string }>
  defaultReasoningEffort: ReasoningEffort
}

interface ModelSettings {
  provider: 'openai-compatible'
  baseUrl: string
  model: string
  hasApiKey: boolean
  configured: boolean
}

interface ModelSettingsForm {
  provider: 'openai-compatible'
  baseUrl: string
  apiKey: string
  model: string
}

interface ConversationList {
  activeId: string
  items: Array<{ id: string; title: string; createdAt: string; updatedAt: string }>
}

interface EvidenceList {
  items: EvidenceSource[]
}

const EMPTY_WORKSPACE: WorkspaceCatalog = {
  activeProjectId: '', activeWorkflowRunId: '', projects: [], runs: [],
}

const BUILTIN_MODELS: ModelCatalog = {
  enabled: false,
  models: [{ id: 'builtin', label: '内置 Agent' }],
  defaultModel: 'builtin',
  reasoningEfforts: [
    { id: 'low', label: '低', description: '响应更快' },
    { id: 'medium', label: '中', description: '速度与推理平衡' },
    { id: 'high', label: '高', description: '更充分地推理' },
  ],
  defaultReasoningEffort: 'medium',
}

const SUGGESTIONS = [
  { label: '检查状态', prompt: '检查当前工作流状态', icon: Activity },
  { label: '推进下一步', prompt: '推进到下一步', icon: ChevronRight },
  { label: '暂停一小时', prompt: '暂停一小时', icon: Clock3 },
]

const TOOL_LABELS: Record<string, { label: string; action: string }> = {
  workflow_status: { label: '读取工作流状态', action: '检查状态' },
  workflow_advance: { label: '推进工作流', action: '发起推进' },
  workflow_pause: { label: '暂停与定时唤醒', action: '发起暂停' },
  workflow_wake: { label: '立即唤醒', action: '唤醒' },
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `请求失败 (${response.status})`)
  return body
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function fileSize(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KB`
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`
}

function wakeCountdown(wakeAt: string, currentTime: number): string {
  const remaining = Math.max(0, new Date(wakeAt).getTime() - currentTime)
  if (remaining === 0) return '正在唤醒…'
  const totalSeconds = Math.ceil(remaining / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function agentState(snapshot: AgentSnapshot): { label: string; detail: string; tone: string } {
  if (!snapshot.connected) return { label: '正在重连', detail: '本地服务暂不可达', tone: 'offline' }
  if (snapshot.agentState === 'PAUSED') return { label: '已暂停', detail: '等待唤醒后继续', tone: 'paused' }
  if (snapshot.agentState === 'WAITING') return { label: '等待确认', detail: '工具尚未执行', tone: 'waiting' }
  if (snapshot.agentState === 'THINKING') return { label: '正在思考', detail: '正在检查工作流上下文', tone: 'thinking' }
  return { label: 'Agent 就绪', detail: '本地服务运行中', tone: 'ready' }
}

function presentMessage(content: string): string {
  const legacyWelcome = 'WetFlow 已就绪。你可以让我检查当前流程、生成工具提案，或暂停任务并设置唤醒时间。'
  let result = content === legacyWelcome
    ? '我已经接入当前工作流。你可以让我检查状态、推进下一阶段，或暂停任务并设置唤醒时间。'
    : content
  for (const stage of WORKFLOW_STAGES) {
    result = result.replaceAll(stage.key, `「${stage.label}」`)
    result = result.replaceAll(stage.key.replaceAll('_', ' '), `「${stage.label}」`)
  }
  const statuses: Record<string, string> = {
    RUNNING: '运行中', WAITING_APPROVAL: '等待确认', PAUSED: '已暂停', COMPLETED: '已完成',
  }
  for (const [status, label] of Object.entries(statuses)) result = result.replaceAll(status, label)
  return result
}

function approvalOutcome(approval: ApprovalRequest, content: string): string {
  if (approval.tool === 'workflow_advance' && approval.status === 'APPROVED') {
    return '阶段推进已完成，工作流状态已持久化。'
  }
  if (approval.tool === 'workflow_pause' && approval.status === 'APPROVED') {
    return '暂停已生效，唤醒计划已持久化。'
  }
  return presentMessage(content)
}

function ApprovalDetails({ approval }: { approval: ApprovalRequest }) {
  return (
    <div className="approval-details">
      <div className="approval-details__topline">
        <span className="approval-details__label"><ShieldCheck size={14} /> 工具审批</span>
        <span className={`risk risk--${approval.risk.toLowerCase()}`}>
          {approval.risk === 'HIGH' ? '高影响' : approval.risk === 'MEDIUM' ? '中等影响' : '低影响'}
        </span>
      </div>
      <strong>{approval.title}</strong>
      <p>{presentMessage(approval.summary)}</p>
      <div className="tool-name"><span>工具</span><code>{approval.tool}</code></div>
    </div>
  )
}

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const statusLabel = approval.status === 'APPROVED' ? '已通过并执行' : '已拒绝'
  return (
    <section className={`approval-card approval-card--${approval.status.toLowerCase()}`} aria-label={statusLabel}>
      <header className="approval-card__header">
        <span className="approval-card__badge"><i className="status-dot" /> {statusLabel}</span>
        <span>{relativeTime(approval.resolvedAt ?? approval.createdAt)}</span>
      </header>
      <div className="approval-card__content">
        <strong>{approval.title}</strong>
        <p>{approvalOutcome(approval, approval.summary)}</p>
        <div className="tool-name"><span>工具</span><code>{approval.tool}</code></div>
      </div>
    </section>
  )
}

function Message({ message, approval, editing, draft, busy, onEdit, onDraftChange, onSave, onCancel }: {
  message: ChatMessage
  approval: ApprovalRequest | undefined
  editing: boolean
  draft: string
  busy: boolean
  onEdit: () => void
  onDraftChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  if (message.role === 'system') return (
    <div className="system-message"><Sparkles size={13} /> <span>{message.content}</span></div>
  )
  const agent = message.role === 'assistant'
  return (
    <article className={`message ${agent ? 'message--agent' : 'message--user'} ${approval ? 'message--with-approval' : ''}`}>
      {agent && <div className="message__avatar"><Bot size={15} /></div>}
      <div className="message__content">
        {agent && <div className="message__author">WetFlow <span>{relativeTime(message.createdAt)}</span></div>}
        {editing
          ? <div className="message-editor">
            <textarea
              value={draft}
              autoFocus
              rows={Math.min(8, Math.max(2, draft.split('\n').length))}
              aria-label="编辑消息"
              disabled={busy}
              onChange={event => onDraftChange(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSave() }
                if (event.key === 'Escape') { event.preventDefault(); onCancel() }
              }}
            />
            <div className="message-editor__actions">
              <span>将替换这条消息之后的回复</span>
              <button className="button button--quiet" disabled={busy} onClick={onCancel}>取消</button>
              <button className="button button--primary" disabled={busy || !draft.trim()} onClick={onSave}>{busy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}更新并重试</button>
            </div>
          </div>
          : <><p>{presentMessage(message.content)}</p>{!agent && <button className="message-edit" aria-label="编辑消息" title="编辑消息" onClick={onEdit}><Pencil size={12} /></button>}</>}
        {approval && approval.status !== 'PENDING' && <ApprovalCard approval={approval} />}
      </div>
    </article>
  )
}

function StageTimeline({ currentIndex }: { currentIndex: number }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <section className="timeline-section">
      <button className="section-toggle" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
        <span><History size={14} /> 流程路线</span>
        <span>{String(currentIndex + 1).padStart(2, '0')} / {String(WORKFLOW_STAGES.length).padStart(2, '0')}<ChevronDown size={14} /></span>
      </button>
      <div className={`stage-list ${expanded ? 'stage-list--expanded' : ''}`}>
        {WORKFLOW_STAGES.map((stage, index) => {
          const done = index < currentIndex
          const active = index === currentIndex
          const nearby = index >= Math.max(0, currentIndex - 1) && index <= Math.min(WORKFLOW_STAGES.length - 1, currentIndex + 2)
          return (
            <div key={stage.key} aria-current={active ? 'step' : undefined} className={`stage-row ${done ? 'stage-row--done' : ''} ${active ? 'stage-row--active' : ''} ${!expanded && !nearby ? 'stage-row--hidden' : ''}`}>
              <span className="stage-row__marker">{done ? <Check size={11} /> : active ? <Circle size={7} fill="currentColor" /> : String(index + 1).padStart(2, '0')}</span>
              <div><strong>{stage.label}</strong>{active && <small>{stage.description}</small>}</div>
              {active && <span className="stage-row__tag">当前</span>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function WorkflowPanel({ snapshot, onWake, onRefresh, onClose, busy }: {
  snapshot: AgentSnapshot
  onWake: () => void
  onRefresh: () => void
  onClose: () => void
  busy: boolean
}) {
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [activityOpen, setActivityOpen] = useState(true)
  const currentIndex = WORKFLOW_STAGES.findIndex(stage => stage.key === snapshot.workflow.currentStage)
  const safeIndex = Math.max(0, currentIndex)
  const current = WORKFLOW_STAGES[safeIndex]
  const next = WORKFLOW_STAGES[safeIndex + 1]
  const paused = snapshot.workflow.status === 'PAUSED'
  const waiting = snapshot.workflow.status === 'WAITING_APPROVAL'

  useEffect(() => {
    if (!snapshot.workflow.wakeAt) return
    setCurrentTime(Date.now())
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [snapshot.workflow.wakeAt])

  return (
    <aside className="context-panel">
      <header className="context-panel__head">
        <div className="context-panel__actions">
          <button className="icon-button" aria-label="刷新状态" onClick={onRefresh}><RefreshCw size={14} /></button>
          <button className="icon-button" aria-label="关闭工作流面板" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="eyebrow">项目上下文</div>
        <strong>{snapshot.workflow.project}</strong>
        <span className="context-panel__workflow">{snapshot.workflow.name}</span>
      </header>

      <section className={`stage-focus ${paused ? 'stage-focus--paused' : ''} ${waiting ? 'stage-focus--waiting' : ''}`}>
        <div className="stage-focus__topline">
          <span className="stage-focus__status"><i className="status-dot" />{paused ? '流程已暂停' : waiting ? '等待人工确认' : '正在进行'}</span>
          <span className="stage-focus__counter">{String(safeIndex + 1).padStart(2, '0')} / {String(WORKFLOW_STAGES.length).padStart(2, '0')}</span>
        </div>
        <h2>{current?.label ?? snapshot.workflow.currentStage}</h2>
        <p>{paused ? snapshot.workflow.pauseReason : current?.description}</p>
        {!paused && next && <div className="next-stage"><span>接下来</span><strong>{next.label}</strong><ChevronRight size={13} /></div>}
        {paused && snapshot.workflow.wakeAt && (
          <div className="wake-schedule">
            <Clock3 size={14} />
            <div><span>自动唤醒</span><strong>{wakeCountdown(snapshot.workflow.wakeAt, currentTime)}</strong><small>{new Date(snapshot.workflow.wakeAt).toLocaleString('zh-CN')}</small></div>
          </div>
        )}
        {paused && <button className="button button--primary button--wake" disabled={busy} onClick={onWake}><Play size={14} fill="currentColor" /> 立即唤醒</button>}
      </section>

      <div className="progress-track" aria-label={`整体进度 ${safeIndex + 1}/${WORKFLOW_STAGES.length}`}>
        <i style={{ width: `${((safeIndex + 1) / WORKFLOW_STAGES.length) * 100}%` }} />
      </div>

      <StageTimeline currentIndex={safeIndex} />

      <section className="context-window" aria-label="模型上下文窗口">
        <div className="context-window__head">
          <span><BrainCircuit size={14} /> 模型上下文</span>
          <code>r{snapshot.context.workflowRevision}</code>
        </div>
        <div className="context-window__metrics">
          <div><span>消息</span><strong>{snapshot.context.selectedMessages} / {snapshot.context.totalMessages}</strong></div>
          <div><span>估算 Token</span><strong>{snapshot.context.estimatedTokens.toLocaleString()} / {snapshot.context.tokenBudget.toLocaleString()}</strong></div>
        </div>
        <div className="context-window__sources">
          <span>长期记忆 <strong>{snapshot.context.memoryMessages}</strong></span>
          <span>证据片段 <strong>{snapshot.context.evidenceChunks}</strong></span>
        </div>
        <div className="context-window__track"><i style={{ width: `${Math.min(100, snapshot.context.estimatedTokens / Math.max(1, snapshot.context.tokenBudget) * 100)}%` }} /></div>
        <small>{snapshot.context.omittedMessages > 0
          ? `${snapshot.context.omittedMessages} 条较早消息未进入本轮模型请求`
          : '当前对话消息均可进入本轮模型请求'}</small>
      </section>

      <section className="activity-section">
        <button className="section-toggle" onClick={() => setActivityOpen(value => !value)} aria-expanded={activityOpen}>
          <span><Activity size={14} /> 最近活动</span>
          <span>{snapshot.activity.length}<ChevronDown size={14} /></span>
        </button>
        {activityOpen && <div className="activity-list">
          {snapshot.activity.slice(0, 6).map(item => (
            <div className="activity-row" key={item.id}>
              <span className={`activity-dot activity-dot--${item.type}`} />
              <div><strong>{item.label}</strong><small>{presentMessage(item.detail)}</small></div>
              <time>{relativeTime(item.createdAt)}</time>
            </div>
          ))}
        </div>}
      </section>
    </aside>
  )
}

export function App() {
  const [snapshot, setSnapshot] = useState<AgentSnapshot>(EMPTY)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [decisionBusy, setDecisionBusy] = useState<{ id: string; decision: 'approve' | 'reject' }>()
  const [error, setError] = useState<string>()
  const [showLatest, setShowLatest] = useState(false)
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [workspaceCatalog, setWorkspaceCatalog] = useState<WorkspaceCatalog>(EMPTY_WORKSPACE)
  const [workspaceCreateMode, setWorkspaceCreateMode] = useState<'project' | 'run'>()
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState('')
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [evidenceBusy, setEvidenceBusy] = useState(false)
  const [evidenceList, setEvidenceList] = useState<EvidenceList>({ items: [] })
  const [toolsOpen, setToolsOpen] = useState(false)
  const [modelingOpen, setModelingOpen] = useState(false)
  const [researchOpen, setResearchOpen] = useState(false)
  const [conversationList, setConversationList] = useState<ConversationList>({ activeId: '', items: [] })
  const [editingConversationId, setEditingConversationId] = useState<string>()
  const [conversationTitleDraft, setConversationTitleDraft] = useState('')
  const [editingMessageId, setEditingMessageId] = useState<string>()
  const [messageDraft, setMessageDraft] = useState('')
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>(BUILTIN_MODELS)
  const [selectedModel, setSelectedModel] = useState(() => window.localStorage.getItem('wetflow.model') ?? '')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState<string>()
  const [savedSettings, setSavedSettings] = useState<ModelSettings>()
  const [settingsForm, setSettingsForm] = useState<ModelSettingsForm>({
    provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '',
  })
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => {
    const saved = window.localStorage.getItem('wetflow.reasoningEffort')
    return saved === 'low' || saved === 'high' ? saved : 'medium'
  })
  const [dark, setDark] = useState(() => {
    const saved = window.localStorage.getItem('wetflow.theme')
    return saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  const [panelOpen, setPanelOpen] = useState(() => {
    if (!window.matchMedia('(min-width: 1121px)').matches) return false
    return window.localStorage.getItem('wetflow.panelOpen') !== 'false'
  })
  const bottomRef = useRef<HTMLDivElement>(null)
  const conversationRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const evidenceInputRef = useRef<HTMLInputElement>(null)
  const loadedRef = useRef(false)
  const shouldScrollRef = useRef(false)

  const loadWorkspace = useCallback(async () => {
    try {
      setWorkspaceCatalog(await request<WorkspaceCatalog>('/api/workspace'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const loadEvidence = useCallback(async () => {
    try {
      setEvidenceList(await request<EvidenceList>('/api/evidence'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await request<AgentSnapshot>('/api/snapshot')
      const conversation = conversationRef.current
      if (loadedRef.current && conversation && conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 140) {
        shouldScrollRef.current = true
      }
      loadedRef.current = true
      setSnapshot(next)
      setError(undefined)
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [])

  useEffect(() => {
    void load()
    void loadWorkspace()
    void loadEvidence()
    void request<ModelCatalog>('/api/models').then(catalog => {
      setModelCatalog(catalog)
      setSelectedModel(current => catalog.models.some(item => item.id === current)
        ? current
        : catalog.defaultModel || catalog.models[0]?.id || '')
      setReasoningEffort(current => catalog.reasoningEfforts.some(item => item.id === current)
        ? current
        : catalog.defaultReasoningEffort)
    }).catch(() => setModelCatalog(BUILTIN_MODELS))
    const source = new EventSource('/api/events')
    source.onopen = () => void load()
    source.onmessage = () => void load()
    source.onerror = () => setSnapshot(current => ({ ...current, connected: false }))
    return () => source.close()
  }, [load, loadEvidence, loadWorkspace])

  useEffect(() => {
    if (selectedModel) window.localStorage.setItem('wetflow.model', selectedModel)
  }, [selectedModel])

  useEffect(() => {
    window.localStorage.setItem('wetflow.reasoningEffort', reasoningEffort)
  }, [reasoningEffort])

  useEffect(() => {
    if (window.matchMedia('(min-width: 1121px)').matches) {
      window.localStorage.setItem('wetflow.panelOpen', String(panelOpen))
    }
  }, [panelOpen])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0e0e0d' : '#ffffff')
    window.localStorage.setItem('wetflow.theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    requestAnimationFrame(() => {
      const conversation = conversationRef.current
      if (shouldScrollRef.current) {
        shouldScrollRef.current = false
        bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
        return
      }
      if (conversation) setShowLatest(conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight > 180)
    })
  }, [snapshot.messages.length])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); inputRef.current?.focus()
      }
      if (event.key === 'Escape') {
        setSettingsOpen(false)
        setEditingMessageId(undefined)
        setEditingConversationId(undefined)
        setConversationMenuOpen(false)
        setWorkspaceMenuOpen(false)
        setWorkspaceCreateMode(undefined)
        setEvidenceOpen(false)
        setToolsOpen(false)
        setPanelOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const pending = useMemo(() => snapshot.approvals.filter(item => item.status === 'PENDING'), [snapshot.approvals])
  const activeApproval = pending[0]
  const approvalsById = useMemo(() => new Map(snapshot.approvals.map(item => [item.id, item])), [snapshot.approvals])
  const externalModelSelected = modelCatalog.enabled && selectedModel !== 'builtin'
  const state = decisionBusy
    ? { label: '正在执行', detail: '工具事务提交中', tone: 'thinking' }
    : busy ? { label: '正在思考', detail: '正在检查工作流上下文', tone: 'thinking' }
      : agentState(snapshot)

  const send = async (content = input) => {
    const value = content.trim()
    if (!value || busy) return
    setBusy(true); setInput(''); setError(undefined)
    try {
      const next = await request<AgentSnapshot>('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          content: value,
          ...(modelCatalog.enabled && selectedModel ? { model: selectedModel, reasoningEffort } : {}),
        }),
      })
      shouldScrollRef.current = true
      setSnapshot(next)
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setInput(value) }
    finally { setBusy(false); inputRef.current?.focus() }
  }

  const startEditingMessage = (message: ChatMessage) => {
    setEditingMessageId(message.id)
    setMessageDraft(message.content)
  }

  const saveMessage = async (messageId: string) => {
    const content = messageDraft.trim()
    if (!content || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const next = await request<AgentSnapshot>(`/api/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          content,
          ...(modelCatalog.enabled && selectedModel ? { model: selectedModel, reasoningEffort } : {}),
        }),
      })
      shouldScrollRef.current = true
      setSnapshot(next)
      setEditingMessageId(undefined)
      setMessageDraft('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setBusy(true); setDecisionBusy({ id, decision }); setError(undefined)
    try {
      const next = await request<AgentSnapshot>(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision }) })
      shouldScrollRef.current = true
      setSnapshot(next)
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false); setDecisionBusy(undefined) }
  }

  const wake = async () => {
    setBusy(true); setError(undefined)
    try {
      const next = await request<AgentSnapshot>('/api/wake', { method: 'POST', body: '{}' })
      shouldScrollRef.current = true
      setSnapshot(next)
      setPanelOpen(false)
      setToolsOpen(false)
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const newConversation = async () => {
    if (busy || decisionBusy) return
    setBusy(true)
    setError(undefined)
    try {
      const next = await request<AgentSnapshot>('/api/conversations', { method: 'POST', body: '{}' })
      setInput('')
      setSnapshot(next)
      setShowLatest(false)
      setConversationMenuOpen(false)
      setWorkspaceMenuOpen(false)
      setEvidenceOpen(false)
      void loadConversations()
      conversationRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      inputRef.current?.focus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const loadConversations = async () => {
    try {
      setConversationList(await request<ConversationList>('/api/conversations'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const toggleConversationMenu = () => {
    setToolsOpen(false)
    setWorkspaceMenuOpen(false)
    setEvidenceOpen(false)
    setConversationMenuOpen(current => {
      if (!current) void loadConversations()
      return !current
    })
  }

  const toggleWorkspaceMenu = () => {
    setToolsOpen(false)
    setConversationMenuOpen(false)
    setEvidenceOpen(false)
    setWorkspaceMenuOpen(current => {
      if (!current) void loadWorkspace()
      return !current
    })
  }

  const startWorkspaceCreate = (mode: 'project' | 'run') => {
    setWorkspaceCreateMode(mode)
    setWorkspaceNameDraft('')
  }

  const createWorkspaceItem = async () => {
    const name = workspaceNameDraft.replace(/\s+/g, ' ').trim()
    if (!workspaceCreateMode || !name || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const next = await request<AgentSnapshot>(workspaceCreateMode === 'project' ? '/api/projects' : '/api/workflow-runs', {
        method: 'POST',
        body: JSON.stringify(workspaceCreateMode === 'project'
          ? { name }
          : { name, projectId: workspaceCatalog.activeProjectId }),
      })
      setSnapshot(next)
      setWorkspaceCreateMode(undefined)
      setWorkspaceNameDraft('')
      setShowLatest(false)
      await Promise.all([loadWorkspace(), loadConversations(), loadEvidence()])
      conversationRef.current?.scrollTo({ top: 0 })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const switchWorkflowRun = async (workflowRunId: string) => {
    if (busy || workflowRunId === workspaceCatalog.activeWorkflowRunId) return
    setBusy(true)
    setError(undefined)
    try {
      const next = await request<AgentSnapshot>(`/api/workflow-runs/${workflowRunId}/activate`, {
        method: 'POST', body: '{}',
      })
      setSnapshot(next)
      setWorkspaceCatalog(current => ({
        ...current,
        activeProjectId: next.workflow.projectId,
        activeWorkflowRunId: workflowRunId,
      }))
      setWorkspaceMenuOpen(false)
      setShowLatest(false)
      await Promise.all([loadConversations(), loadEvidence()])
      conversationRef.current?.scrollTo({ top: 0 })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const startEditingConversation = (conversationId: string, title: string) => {
    setEditingConversationId(conversationId)
    setConversationTitleDraft(title)
  }

  const saveConversationTitle = async (conversationId: string) => {
    const title = conversationTitleDraft.replace(/\s+/g, ' ').trim()
    if (!title) {
      setError('对话标题不能为空。')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const updated = await request<ConversationList['items'][number]>(`/api/conversations/${conversationId}`, {
        method: 'PATCH', body: JSON.stringify({ title }),
      })
      setConversationList(current => ({
        ...current,
        items: current.items.map(item => item.id === conversationId ? updated : item),
      }))
      setEditingConversationId(undefined)
      setConversationTitleDraft('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const switchConversation = async (conversationId: string) => {
    if (busy || conversationId === conversationList.activeId) {
      setConversationMenuOpen(false)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const next = await request<AgentSnapshot>(`/api/conversations/${conversationId}/activate`, {
        method: 'POST', body: '{}',
      })
      setSnapshot(next)
      setConversationList(current => ({ ...current, activeId: conversationId }))
      setConversationMenuOpen(false)
      setShowLatest(false)
      conversationRef.current?.scrollTo({ top: 0 })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const openSettings = async () => {
    setWorkspaceMenuOpen(false)
    setConversationMenuOpen(false)
    setToolsOpen(false)
    setEvidenceOpen(false)
    setSettingsOpen(true)
    setSettingsBusy(true)
    setSettingsError(undefined)
    try {
      const settings = await request<ModelSettings>('/api/model-settings')
      setSavedSettings(settings)
      setSettingsForm({
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        apiKey: '',
        model: settings.model,
      })
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSettingsBusy(false)
    }
  }

  const saveSettings = async () => {
    if (settingsBusy) return
    setSettingsBusy(true)
    setSettingsError(undefined)
    try {
      const settings = await request<ModelSettings>('/api/model-settings', {
        method: 'POST', body: JSON.stringify(settingsForm),
      })
      setSavedSettings(settings)
      const catalog = await request<ModelCatalog>('/api/models')
      setModelCatalog(catalog)
      setSelectedModel(catalog.models.some(item => item.id === settings.model)
        ? settings.model
        : catalog.defaultModel || catalog.models[0]?.id || '')
      setReasoningEffort(current => catalog.reasoningEfforts.some(item => item.id === current)
        ? current
        : catalog.defaultReasoningEffort)
      setSettingsOpen(false)
      setSettingsForm(current => ({ ...current, apiKey: '' }))
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSettingsBusy(false)
    }
  }

  const useTool = (toolName: string) => {
    setToolsOpen(false)
    if (toolName === 'workflow_status') { void send('检查当前工作流状态'); return }
    if (toolName === 'workflow_advance') { void send('推进到下一步'); return }
    if (toolName === 'workflow_pause') { void send('暂停一小时'); return }
    if (toolName === 'workflow_wake') void wake()
  }

  const toggleEvidence = () => {
    setWorkspaceMenuOpen(false)
    setConversationMenuOpen(false)
    setToolsOpen(false)
    setEvidenceOpen(current => {
      if (!current) void loadEvidence()
      return !current
    })
  }

  const importEvidence = async (files: FileList | null) => {
    const selected = [...(files ? Array.from(files) : [])]
    if (selected.length === 0 || evidenceBusy) return
    if (selected.length > 10) {
      setError('一次最多导入 10 份资料。')
      return
    }
    setEvidenceBusy(true)
    setError(undefined)
    try {
      for (const file of selected) {
        if (file.size > 2_000_000) throw new Error(`“${file.name}”超过 2 MB。`)
        const content = await file.text()
        await request<EvidenceSource>('/api/evidence', {
          method: 'POST',
          body: JSON.stringify({ name: file.name, mimeType: file.type || 'text/plain', content }),
        })
      }
      await Promise.all([loadEvidence(), load()])
      setEvidenceOpen(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setEvidenceBusy(false)
      if (evidenceInputRef.current) evidenceInputRef.current.value = ''
    }
  }

  return (
    <div className={`app-shell ${panelOpen ? 'app-shell--panel-open' : ''}`}>
      <nav className="rail" aria-label="主导航">
        <div className="brand-mark"><FlaskConical size={16} /></div>
        <button className="rail-button rail-new-chat" aria-label="新建对话" title="新建对话" disabled={busy} onClick={() => void newConversation()}><Plus size={18} /></button>
        <button className={`rail-button ${workspaceMenuOpen ? 'rail-button--active' : ''}`} aria-label="项目与工作流运行" aria-expanded={workspaceMenuOpen} onClick={toggleWorkspaceMenu}><FolderKanban size={17} /></button>
        <button className={`rail-button ${modelingOpen ? 'rail-button--active' : ''}`} aria-label="生物过程建模" title="生物过程建模" aria-pressed={modelingOpen} onClick={() => { setModelingOpen(value => !value); setResearchOpen(false) }}><FlaskConical size={17} /></button>
        <button className={`rail-button ${researchOpen ? 'rail-button--active' : ''}`} aria-label="搜索建库" title="搜索建库" aria-pressed={researchOpen} onClick={() => { setResearchOpen(value => !value); setModelingOpen(false) }}><Database size={17} /></button>
        <button className={`rail-button ${conversationMenuOpen ? 'rail-button--active' : ''}`} aria-label="对话列表" aria-expanded={conversationMenuOpen} onClick={toggleConversationMenu}><MessageSquare size={17} /></button>
        <button className={`rail-button ${panelOpen ? 'rail-button--active' : ''}`} aria-label={panelOpen ? '隐藏工作流' : '查看工作流'} onClick={() => setPanelOpen(value => !value)}><Activity size={17} /></button>
        <button className={`rail-button ${toolsOpen ? 'rail-button--active' : ''}`} aria-label="工具与唤醒" aria-expanded={toolsOpen} onClick={() => { setToolsOpen(value => !value); setConversationMenuOpen(false); setWorkspaceMenuOpen(false); setEvidenceOpen(false) }}><Wrench size={16} /></button>
        <div className="rail-spacer" />
        <button className="icon-button" aria-label={dark ? '切换为浅色外观' : '切换为深色外观'} aria-pressed={dark} onClick={() => setDark(value => !value)}>{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
        <button className={`icon-button ${settingsOpen ? 'icon-button--active' : ''}`} aria-label="模型设置" aria-haspopup="dialog" onClick={() => void openSettings()}><Settings2 size={15} /></button>
        <div className={`connection ${snapshot.connected ? 'connection--online' : ''}`} title={snapshot.connected ? '服务已连接' : '正在重连'} />
      </nav>

      <main className="workspace">
        <header className="topbar">
          <div className="topbar__title">
            <button className="mobile-menu" onClick={() => setPanelOpen(true)} aria-label="打开工作流"><Menu size={17} /></button>
            <button className="workspace-trigger" onClick={toggleWorkspaceMenu} aria-expanded={workspaceMenuOpen}>
              <span><strong>{snapshot.workflow.name}</strong><small>{snapshot.workflow.project}</small></span><ChevronDown size={13} />
            </button>
          </div>
          <div className="topbar__actions">
            <button className="mobile-theme" aria-label="新建对话" title="新建对话" disabled={busy} onClick={() => void newConversation()}><Plus size={16} /></button>
            <button className="mobile-theme" aria-label="对话列表" aria-expanded={conversationMenuOpen} onClick={toggleConversationMenu}><History size={15} /></button>
            <button className="mobile-theme" aria-label="搜索建库" aria-pressed={researchOpen} onClick={() => { setResearchOpen(value => !value); setModelingOpen(false) }}><Database size={15} /></button>
            <button className="mobile-theme" aria-label="工具与唤醒" aria-expanded={toolsOpen} onClick={() => { setToolsOpen(value => !value); setConversationMenuOpen(false); setWorkspaceMenuOpen(false); setEvidenceOpen(false) }}><Wrench size={15} /></button>
            <button className="mobile-theme" aria-label={dark ? '切换为浅色外观' : '切换为深色外观'} aria-pressed={dark} onClick={() => setDark(value => !value)}>{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
            <button className="mobile-theme" aria-label="模型设置" aria-haspopup="dialog" onClick={() => void openSettings()}><Settings2 size={15} /></button>
            <button className={`agent-pill agent-pill--${state.tone}`} onClick={() => setPanelOpen(true)} aria-label={`${state.label}，打开工作流状态`} aria-live="polite">
              <span className="status-dot" /><span><strong>{state.label}</strong><small>{state.detail}</small></span><PanelRight size={14} />
            </button>
          </div>
        </header>

        {researchOpen
          ? <ResearchWorkspace key={workspaceCatalog.activeWorkflowRunId || snapshot.workflow.id} runId={workspaceCatalog.activeWorkflowRunId || snapshot.workflow.id} />
          : modelingOpen
          ? <ModelingWorkspace key={workspaceCatalog.activeWorkflowRunId || snapshot.workflow.id} runId={workspaceCatalog.activeWorkflowRunId || snapshot.workflow.id} />
          : <><section
          className="conversation"
          aria-label="对话"
          ref={conversationRef}
          onScroll={event => {
            const node = event.currentTarget
            setShowLatest(node.scrollHeight - node.scrollTop - node.clientHeight > 180)
          }}
        >
          <div className="conversation__inner">
            <div className="message-list">
              {snapshot.messages.length === 0 && <div className="empty-conversation">
                <MessageSquare size={18} />
                <strong>新对话</strong>
                <span>工作流状态已保留，可以从新的上下文继续。</span>
              </div>}
              {snapshot.messages.map(message => (
                <Message
                  key={message.id}
                  message={message}
                  approval={message.approvalId ? approvalsById.get(message.approvalId) : undefined}
                  editing={editingMessageId === message.id}
                  draft={editingMessageId === message.id ? messageDraft : ''}
                  busy={busy}
                  onEdit={() => startEditingMessage(message)}
                  onDraftChange={setMessageDraft}
                  onSave={() => void saveMessage(message.id)}
                  onCancel={() => { setEditingMessageId(undefined); setMessageDraft('') }}
                />
              ))}
              {busy && <div className="thinking" aria-label="Agent 正在处理"><span /><span /><span /></div>}
              <div ref={bottomRef} />
            </div>
          </div>
          {showLatest && <button className="jump-latest" onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}><ArrowDown size={13} />回到最新</button>}
        </section>

        <footer className="composer-dock">
          <div className="composer-wrap">
            {error && <div className="error-strip" role="alert"><XCircle size={14} /><span>{error}</span><button onClick={() => setError(undefined)} aria-label="关闭错误"><X size={13} /></button></div>}
            <div className={`composer ${activeApproval ? 'composer--approval' : ''}`}>
              {activeApproval && <ApprovalDetails approval={activeApproval} />}
              <textarea
                ref={inputRef}
                value={input}
                onChange={event => { setInput(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px` }}
                onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }}
                placeholder={activeApproval ? '追问这项操作的影响，或直接作出决定…' : '告诉 WetFlow 你接下来想做什么'}
                aria-label="给 WetFlow 发送消息"
                rows={1}
                disabled={busy}
              />
              <div className="composer__footer">
                <span>{activeApproval ? <><span className="approval-lock"><ShieldCheck size={12} />执行前保持不变</span>{pending.length > 1 && ` · 还有 ${pending.length - 1} 项待处理`}</> : <><kbd>Ctrl</kbd><kbd>K</kbd> 聚焦 · <kbd>Shift</kbd><kbd>Enter</kbd> 换行</>}</span>
                <div className="composer__actions">
                  {activeApproval && <>
                    <button className="composer-decision composer-decision--reject" disabled={busy} onClick={() => void decide(activeApproval.id, 'reject')}>
                      {decisionBusy?.id === activeApproval.id && decisionBusy.decision === 'reject' ? <LoaderCircle className="spin" size={14} /> : <X size={14} />}<span>{decisionBusy?.id === activeApproval.id && decisionBusy.decision === 'reject' ? '拒绝中' : '拒绝'}</span>
                    </button>
                    <button className="composer-decision composer-decision--approve" disabled={busy} onClick={() => void decide(activeApproval.id, 'approve')}>
                      {decisionBusy?.id === activeApproval.id && decisionBusy.decision === 'approve' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}<span>{decisionBusy?.id === activeApproval.id && decisionBusy.decision === 'approve' ? '执行中' : '通过并执行'}</span>
                    </button>
                  </>}
                  <button className="send-button" disabled={busy || input.trim() === ''} onClick={() => void send()} aria-label={activeApproval ? '发送追问' : '发送消息'}><ArrowUp size={16} /></button>
                </div>
              </div>
            </div>
            <div className="composer-settings" aria-label="上下文与模型设置">
              <button className={`composer-source-button ${evidenceOpen ? 'composer-source-button--active' : ''}`} disabled={evidenceBusy} onClick={toggleEvidence}>
                {evidenceBusy ? <LoaderCircle className="spin" size={13} /> : <Paperclip size={13} />}
                <span>资料 {evidenceList.items.length}</span>
              </button>
              <input
                className="sr-only"
                ref={evidenceInputRef}
                type="file"
                multiple
                accept=".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.yaml,.yml,.xml,.html,text/*,application/json"
                aria-label="导入本地文本资料"
                onChange={event => void importEvidence(event.target.files)}
              />
              <label className="composer-select">
                <Bot size={13} />
                <span className="sr-only">选择模型</span>
                <select
                  value={selectedModel || modelCatalog.defaultModel}
                  disabled={busy || modelCatalog.models.length === 0}
                  onChange={event => {
                    if (event.target.value === '__configure__') { void openSettings(); return }
                    setSelectedModel(event.target.value)
                  }}
                  aria-label="选择模型"
                >
                  {modelCatalog.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                  <option disabled>──────────</option>
                  <option value="__configure__">＋ 配置模型提供商…</option>
                </select>
                <ChevronDown size={12} />
              </label>
              <label className={`composer-select ${!externalModelSelected ? 'composer-select--disabled' : ''}`}>
                <BrainCircuit size={13} />
                <span className="select-prefix">思考</span>
                <select
                  value={reasoningEffort}
                  disabled={busy || !externalModelSelected}
                  onChange={event => setReasoningEffort(event.target.value as ReasoningEffort)}
                  aria-label="设置模型思考强度"
                >
                  {modelCatalog.reasoningEfforts.map(effort => (
                    <option key={effort.id} value={effort.id}>{effort.label} · {effort.description}</option>
                  ))}
                </select>
                <ChevronDown size={12} />
              </label>
              {!externalModelSelected && <span className="model-mode-note">内置规则模式</span>}
            </div>
            {!activeApproval && <div className="suggestions" aria-label="快捷操作">
              {SUGGESTIONS.map(item => <button key={item.prompt} disabled={busy} onClick={() => void send(item.prompt)}><item.icon size={13} />{item.label}</button>)}
            </div>}
            <small className="composer-note">正式实验操作前，请核对原始记录与审批内容。</small>
          </div>
        </footer></>}
      </main>

      {evidenceOpen && <>
        <button className="evidence-menu-backdrop" aria-label="关闭本地资料" onClick={() => setEvidenceOpen(false)} />
        <aside className="evidence-menu" aria-label="当前运行的本地资料">
          <header>
            <div><strong>本地资料</strong><span>{snapshot.workflow.name} · {evidenceList.items.length} 份</span></div>
            <button className="icon-button" aria-label="关闭本地资料" onClick={() => setEvidenceOpen(false)}><X size={15} /></button>
          </header>
          <div className="evidence-local-note"><ShieldCheck size={14} /><span>文件只保存在当前运行的本地 SQLite。模型仅接收与问题相关的片段。</span></div>
          <div className="evidence-menu__list">
            {evidenceList.items.length === 0 && <div className="evidence-empty"><FileText size={18} /><strong>还没有资料</strong><span>导入实验记录、Markdown、CSV、JSON 或日志文件。</span></div>}
            {evidenceList.items.map(source => <article className="evidence-item" key={source.id}>
              <div className="evidence-item__icon"><FileText size={14} /></div>
              <div><strong>{source.name}</strong><small>{source.chunkCount} 个片段 · {fileSize(source.sizeBytes)} · {relativeTime(source.updatedAt)}</small></div>
            </article>)}
          </div>
          <footer>
            <button className="button button--primary" disabled={evidenceBusy} onClick={() => evidenceInputRef.current?.click()}>
              {evidenceBusy ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}{evidenceBusy ? '正在导入' : '导入文本资料'}
            </button>
            <span>单个文件 ≤ 2 MB，一次最多 10 份</span>
          </footer>
        </aside>
      </>}

      {workspaceMenuOpen && <>
        <button className="workspace-menu-backdrop" aria-label="关闭项目与运行列表" onClick={() => { setWorkspaceMenuOpen(false); setWorkspaceCreateMode(undefined) }} />
        <aside className="workspace-menu" aria-label="项目与工作流运行">
          <header>
            <div><strong>项目与运行</strong><span>上下文按运行实例完全隔离</span></div>
            <button className="icon-button" aria-label="关闭项目与运行列表" onClick={() => setWorkspaceMenuOpen(false)}><X size={15} /></button>
          </header>
          <div className="workspace-menu__list">
            {workspaceCatalog.projects.map(project => {
              const runs = workspaceCatalog.runs.filter(run => run.projectId === project.id)
              const activeProject = project.id === workspaceCatalog.activeProjectId
              return <section className={`project-group ${activeProject ? 'project-group--active' : ''}`} key={project.id}>
                <div className="project-group__head">
                  <span><FolderKanban size={13} /><strong>{project.name}</strong></span>
                  <small>{project.runCount} 个运行</small>
                </div>
                <div className="run-list">
                  {runs.map(run => {
                    const active = run.id === workspaceCatalog.activeWorkflowRunId
                    const stage = WORKFLOW_STAGES.find(item => item.key === run.currentStage)
                    return <button
                      className={`run-item ${active ? 'run-item--active' : ''}`}
                      key={run.id}
                      aria-current={active ? 'page' : undefined}
                      disabled={busy}
                      onClick={() => void switchWorkflowRun(run.id)}
                    >
                      <GitBranch size={13} />
                      <span><strong>{run.name}</strong><small>{stage?.label ?? run.currentStage} · {relativeTime(run.updatedAt)}</small></span>
                      <i className={`run-status run-status--${run.status.toLowerCase()}`} title={run.status} />
                    </button>
                  })}
                </div>
              </section>
            })}
          </div>
          {workspaceCreateMode && <form className="workspace-create" onSubmit={event => { event.preventDefault(); void createWorkspaceItem() }}>
            <label>{workspaceCreateMode === 'project' ? '新项目名称' : `在“${snapshot.workflow.project}”中新建运行`}</label>
            <div><input
              value={workspaceNameDraft}
              maxLength={80}
              autoFocus
              placeholder={workspaceCreateMode === 'project' ? '例如：A07 第二轮筛选' : '例如：补充验证'}
              disabled={busy}
              onChange={event => setWorkspaceNameDraft(event.target.value)}
            /><button className="button button--primary" type="submit" disabled={busy || !workspaceNameDraft.trim()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}创建</button></div>
          </form>}
          <footer className="workspace-menu__actions">
            <button className="button button--quiet" disabled={busy} onClick={() => startWorkspaceCreate('project')}><FolderKanban size={13} />新项目</button>
            <button className="button button--quiet" disabled={busy || !workspaceCatalog.activeProjectId} onClick={() => startWorkspaceCreate('run')}><GitBranch size={13} />新运行</button>
          </footer>
        </aside>
      </>}

      {conversationMenuOpen && <>
        <button className="conversation-menu-backdrop" aria-label="关闭对话列表" onClick={() => setConversationMenuOpen(false)} />
        <aside className="conversation-menu" aria-label="对话列表">
          <header><div><strong>对话</strong><span>{conversationList.items.length} 个对话</span></div><button className="icon-button" aria-label="新建对话" disabled={busy} onClick={() => void newConversation()}><Plus size={15} /></button></header>
          <div className="conversation-menu__list">
            {conversationList.items.map(item => <div
              key={item.id}
              className={item.id === conversationList.activeId ? 'conversation-item conversation-item--active' : 'conversation-item'}
            >
              {editingConversationId === item.id
                ? <div className="conversation-item__main">
                  <MessageSquare size={14} />
                  <input
                    className="conversation-title-input"
                    value={conversationTitleDraft}
                    maxLength={80}
                    autoFocus
                    aria-label="编辑对话标题"
                    onClick={event => event.stopPropagation()}
                    onChange={event => setConversationTitleDraft(event.target.value)}
                    onKeyDown={event => {
                      event.stopPropagation()
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void saveConversationTitle(item.id) }
                      if (event.key === 'Escape') { event.preventDefault(); setEditingConversationId(undefined) }
                    }}
                  />
                </div>
                : <button className="conversation-item__main" aria-current={item.id === conversationList.activeId ? 'page' : undefined} onClick={() => void switchConversation(item.id)}>
                  <MessageSquare size={14} />
                  <span><strong>{item.title}</strong><small>{relativeTime(item.updatedAt)}</small></span>
                </button>}
              {editingConversationId === item.id
                ? <button className="conversation-item__edit" aria-label="保存标题" disabled={busy} onClick={() => void saveConversationTitle(item.id)}><Check size={13} /></button>
                : <button className="conversation-item__edit" aria-label={`编辑“${item.title}”的标题`} onClick={() => startEditingConversation(item.id, item.title)}><Pencil size={13} /></button>}
            </div>)}
          </div>
        </aside>
      </>}

      {toolsOpen && <>
        <button className="tools-menu-backdrop" aria-label="关闭工具列表" onClick={() => setToolsOpen(false)} />
        <aside className="tools-menu" aria-label="工具与唤醒功能列表">
          <header>
            <div><strong>工具与唤醒</strong><span>{snapshot.tools.length} 个工具已接入</span></div>
            <button className="icon-button" aria-label="关闭工具列表" onClick={() => setToolsOpen(false)}><X size={15} /></button>
          </header>
          <section className={`wake-overview ${snapshot.workflow.status === 'PAUSED' ? 'wake-overview--paused' : ''}`}>
            <div className="wake-overview__top"><span><i className="status-dot" />{snapshot.workflow.status === 'PAUSED' ? 'Agent 已暂停' : 'Agent 正在运行'}</span><code>{snapshot.workflow.currentStage}</code></div>
            {snapshot.workflow.status === 'PAUSED'
              ? <><p>{snapshot.workflow.pauseReason || '工作流正在等待唤醒。'}</p>{snapshot.workflow.wakeAt && <small>计划唤醒：{new Date(snapshot.workflow.wakeAt).toLocaleString('zh-CN')}</small>}<button className="button button--primary" disabled={busy} onClick={() => void wake()}><Play size={13} fill="currentColor" />立即唤醒</button></>
              : <p>当前无需唤醒；你仍可通过工具列表读取状态、发起推进或暂停。</p>}
          </section>
          <div className="tool-list">
            {snapshot.tools.map(tool => {
              const meta = TOOL_LABELS[tool.name] ?? { label: tool.name, action: '使用' }
              const wakeUnavailable = tool.name === 'workflow_wake' && snapshot.workflow.status !== 'PAUSED'
              return <article className="tool-item" key={tool.name}>
                <div className="tool-item__icon"><Wrench size={14} /></div>
                <div className="tool-item__copy"><strong>{meta.label}</strong><code>{tool.name}</code><p>{tool.description}</p></div>
                <div className="tool-item__side">
                  <span className={tool.approvalRequired ? 'tool-access tool-access--approval' : 'tool-access'}>{tool.approvalRequired ? '需审批' : '直接执行'}</span>
                  <button className="button button--quiet" disabled={busy || wakeUnavailable} onClick={() => useTool(tool.name)}>{wakeUnavailable ? '运行中' : meta.action}</button>
                </div>
              </article>
            })}
          </div>
        </aside>
      </>}

      <div className={`panel-backdrop ${panelOpen ? 'panel-backdrop--open' : ''}`} onClick={() => setPanelOpen(false)} />
      <div
        className={`panel-container ${panelOpen ? 'panel-container--open' : ''}`}
        aria-hidden={!panelOpen}
        {...(!panelOpen ? { inert: '' } : {}) as Record<string, string>}
      >
        <WorkflowPanel
          snapshot={snapshot}
          onWake={wake}
          onRefresh={() => void load()}
          onClose={() => setPanelOpen(false)}
          busy={busy}
        />
      </div>

      {settingsOpen && <div className="settings-layer">
        <button className="settings-backdrop" aria-label="关闭模型设置" onClick={() => setSettingsOpen(false)} />
        <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <header className="settings-dialog__head">
            <div className="settings-dialog__icon"><Settings2 size={17} /></div>
            <div><h2 id="settings-title">模型设置</h2><p>连接 OpenAI Compatible 接口</p></div>
            <button className="icon-button" aria-label="关闭模型设置" onClick={() => setSettingsOpen(false)}><X size={16} /></button>
          </header>

          <form onSubmit={event => { event.preventDefault(); void saveSettings() }}>
            <label className="settings-field">
              <span>模型提供商</span>
              <select
                value={settingsForm.provider}
                disabled={settingsBusy}
                onChange={event => setSettingsForm(current => ({ ...current, provider: event.target.value as 'openai-compatible' }))}
              >
                <option value="openai-compatible">OpenAI Compatible</option>
              </select>
            </label>
            <label className="settings-field">
              <span>Base URL</span>
              <input
                type="url"
                value={settingsForm.baseUrl}
                disabled={settingsBusy}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
                onChange={event => setSettingsForm(current => ({ ...current, baseUrl: event.target.value }))}
              />
            </label>
            <label className="settings-field">
              <span>API Key</span>
              <div className="settings-secret">
                <KeyRound size={14} />
                <input
                  type="password"
                  value={settingsForm.apiKey}
                  disabled={settingsBusy}
                  placeholder={savedSettings?.hasApiKey ? '已保存，留空则保持不变' : '输入 API Key'}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={event => setSettingsForm(current => ({ ...current, apiKey: event.target.value }))}
                />
              </div>
            </label>
            <label className="settings-field">
              <span>模型 ID</span>
              <input
                value={settingsForm.model}
                disabled={settingsBusy}
                placeholder="gpt-5.2"
                spellCheck={false}
                onChange={event => setSettingsForm(current => ({ ...current, model: event.target.value }))}
              />
            </label>

            <div className="settings-local-note"><ShieldCheck size={14} /><span>配置仅保存在本机，API Key 不会显示在页面或接口响应中。</span></div>
            {settingsError && <div className="settings-error" role="alert"><XCircle size={14} />{settingsError}</div>}
            <footer className="settings-dialog__actions">
              <button type="button" className="button button--quiet" disabled={settingsBusy} onClick={() => setSettingsOpen(false)}>取消</button>
              <button type="submit" className="button button--primary" disabled={settingsBusy}>
                {settingsBusy && <LoaderCircle className="spin" size={14} />}{settingsBusy ? '处理中' : '保存并启用'}
              </button>
            </footer>
          </form>
        </section>
      </div>}
    </div>
  )
}
