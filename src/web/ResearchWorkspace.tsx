import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Database, FlaskConical, LoaderCircle, Play, RefreshCw, Search, Table2 } from 'lucide-react'
import { ResearchClient, isResearchAbort, type Job, type Profile, type QueryResult, type ResearchProvider, type ResearchRecord, type SchemaTable, type Source } from './research-api.js'

const TABS = [{ id: 'search', label: '检索任务' }, { id: 'sources', label: '文献与数据源' }, { id: 'records', label: '实验记录' }, { id: 'sql', label: 'SQL 查询' }] as const
type Tab = typeof TABS[number]['id']
const ACTIVE = new Set(['QUEUED', 'SEARCHING'])
const STATUS: Record<Job['status'], string> = { QUEUED: '排队中', SEARCHING: '检索中', COMPLETED: '检索完成', PARTIAL: '部分完成', FAILED: '失败', CANCELLED: '已取消', INTERRUPTED: '中断' }
const EMPTY_PROFILE = (runId: string): Profile => ({ runId, enabled: false, goal: '', organism: '', strain: '', metric: 'biomass', conditions: '', customFields: [] })
const DEFAULT_SQL = 'SELECT organism, strain, time, time_unit, value, unit FROM measurements ORDER BY time LIMIT 100'
const EMPTY_RECORD_DRAFT = { sourceId: '', organism: '', strain: '', medium: '', temperatureC: '', pH: '', metric: 'biomass', unit: 'g/L', timeUnit: 'h' as 'h'|'min'|'s', points: '0,0.1\n12,0.8\n24,1.4', evidenceQuote: '', locator: '' }
const LABEL: Record<keyof Omit<Profile, 'runId' | 'enabled' | 'customFields'>, string> = { goal: '研究目标', organism: '物种', strain: '菌株', metric: '关注指标', conditions: '培养条件' }

export function ResearchWorkspace({ runId }: { runId: string }) {
  const client = useMemo(() => new ResearchClient(runId), [runId])
  const epoch = useRef(0)
  const [profile, setProfile] = useState<Profile>(() => EMPTY_PROFILE(runId))
  const [tab, setTab] = useState<Tab>('search')
  const [query, setQuery] = useState('')
  const [providers, setProviders] = useState<ResearchProvider[]>(['europepmc', 'arxiv', 'geo'])
  const [jobs, setJobs] = useState<Job[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [records, setRecords] = useState<ResearchRecord[]>([])
  const [schema, setSchema] = useState<SchemaTable[]>([])
  const [selectedSource, setSelectedSource] = useState<Source>()
  const [selectedRecord, setSelectedRecord] = useState('')
  const [sql, setSql] = useState(DEFAULT_SQL)
  const [result, setResult] = useState<QueryResult>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState({ ...EMPTY_RECORD_DRAFT })
  const [customFields, setCustomFields] = useState('')
  const [activeJobs, setActiveJobs] = useState(false)

  const load = useCallback(async (initial = false, includeProfile = initial) => {
    const generation = epoch.current
    if (initial) setLoading(true)
    try {
      const [j, s, r, sc] = await Promise.all([client.jobs(), client.sources(), client.records(), client.schema()])
      const p = includeProfile ? await client.profile() : undefined
      if (epoch.current !== generation) return
      if (p) { setProfile(p); setCustomFields(p.customFields.join(', ')) }
      setJobs(j.items); setSources(s.items); setRecords(r.items); setSchema(sc.tables)
      setActiveJobs(j.items.some(item => ACTIVE.has(item.status)))
    } catch (caught) { if (epoch.current === generation && !isResearchAbort(caught)) setError(message(caught)) }
    finally { if (epoch.current === generation && initial) setLoading(false) }
  }, [client])

  useEffect(() => {
    epoch.current += 1
    const generation = epoch.current
    setProfile(EMPTY_PROFILE(runId)); setCustomFields(''); setJobs([]); setSources([]); setRecords([]); setSchema([]); setSelectedSource(undefined); setSelectedRecord(''); setResult(undefined); setSql(DEFAULT_SQL); setTab('search'); setQuery(''); setDraft({ ...EMPTY_RECORD_DRAFT }); setBusy(''); setActiveJobs(false); setError(''); setNotice(''); setLoading(true)
    void load(true)
    return () => { if (epoch.current === generation) epoch.current += 1 }
  }, [runId, load])

  useEffect(() => {
    if (!activeJobs) return
    const timer = window.setInterval(() => { void load() }, 1600)
    return () => window.clearInterval(timer)
  }, [activeJobs, load])

  const action = async (key: string, operation: (isCurrent: () => boolean) => Promise<void>) => {
    if (busy) return
    const generation = epoch.current
    setBusy(key); setError(''); setNotice('')
    try { await operation(() => generation === epoch.current) }
    catch (caught) { if (generation === epoch.current && !isResearchAbort(caught)) setError(message(caught)) }
    finally { if (generation === epoch.current) setBusy('') }
  }
  const refresh = async () => { await load(false, true) }
  const recordSource = sources.find(source => source.id === draft.sourceId)
  const saveProfile = () => action('profile', async current => {
    const updated = await client.saveProfile({ enabled: profile.enabled, goal: profile.goal, organism: profile.organism, strain: profile.strain, metric: profile.metric, conditions: profile.conditions, customFields: customFields.split(',').map(item => item.trim()).filter(Boolean) })
    if (!current()) return
    setProfile(updated); setNotice('研究档案已保存。')
  })
  const startSearch = () => action('search', async current => {
    if (providers.length === 0) throw new Error('请至少选择一个检索来源。')
    const job = await client.startJob(query, providers)
    if (!current()) return
    setJobs(current => [job, ...current.filter(item => item.id !== job.id)]); setActiveJobs(ACTIVE.has(job.status)); setTab('search')
    setNotice('检索任务已创建；检索命中不代表已提取实验数据。')
  })
  const updateJob = (item: Job) => setJobs(current => [item, ...current.filter(job => job.id !== item.id)])
  const openSource = (source: Source) => action(`source:${source.id}`, async current => {
    const full = await client.source(source.id); if (!current()) return; setSelectedSource(full); setDraft(current => ({ ...current, sourceId: source.id })); setTab('sources')
  })
  const fetchSource = (source: Source) => action(`fetch:${source.id}`, async current => {
    const full = await client.fetchSource(source.id); if (!current()) return; setSelectedSource(full); setSources(current => current.map(item => item.id === full.id ? full : item)); setNotice('来源内容已更新，可查看获取层级和正文。')
  })
  const saveRecord = () => action('record', async current => {
    const points = draft.points.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const [time, value, ...extra] = line.split(/[\s,;]+/)
      if (extra.length || !time || !value || !Number.isFinite(Number(time)) || !Number.isFinite(Number(value))) throw new Error('时间序列请每行填写“时间,数值”，且必须为有限数字。')
      return { time: Number(time), value: Number(value) }
    })
    if (points.length < 1) throw new Error('请至少填写一个有原文依据的时间点。')
    const source = sources.find(item => item.id === draft.sourceId)
    if (!source) throw new Error('请先选择一个来源。')
    const saved = await client.addRecord({ sourceId: draft.sourceId, organism: draft.organism, strain: draft.strain, medium: draft.medium, ...(draft.temperatureC ? { temperatureC: Number(draft.temperatureC) } : {}), ...(draft.pH ? { pH: Number(draft.pH) } : {}), metric: draft.metric, unit: draft.unit, timeUnit: draft.timeUnit, points, evidenceQuote: draft.evidenceQuote, locator: draft.locator })
    if (!current()) return
    setRecords(current => [saved, ...current]); setSelectedRecord(saved.id); setNotice('实验记录已保存，并保留来源引文与位置。')
  })
  const runQuery = () => action('sql', async current => { const data = await client.query(sql); if (current()) setResult(data) })
  const exportRecord = () => action('export', async current => {
    const exported = await client.exportModeling(selectedRecord)
    if (!current()) return
    setNotice(`已导出数据集“${exported.name}”（${exported.datasetId}）。请打开「生物过程建模」并选择该数据集进行 growth_fit。`)
  })

  return <main className="research-page" aria-label="搜索建库工作区">
    <header className="research-heading"><div><span className="eyebrow">WETFLOW · RESEARCH</span><h1>搜索与建库</h1><p>把公开来源、可定位证据和实验记录保存在当前工作流运行中。</p></div><button className="button button--quiet" onClick={() => void refresh()} disabled={loading || !!busy}><RefreshCw size={14}/>刷新</button></header>
    <section className="research-profile research-card" aria-label="研究档案">
      <div className="research-card__heading"><div><strong>研究档案</strong><small>为当前运行的检索提供上下文</small></div><label className="research-toggle"><input type="checkbox" checked={profile.enabled} onChange={e => setProfile({ ...profile, enabled: e.target.checked })}/>启用研究模式</label></div>
      <div className="research-profile-grid">{(Object.keys(LABEL) as Array<keyof typeof LABEL>).map(field => <label key={field}>{LABEL[field]}{field === 'conditions' ? <textarea rows={2} value={profile[field]} onChange={e => setProfile({ ...profile, [field]: e.target.value })}/> : <input value={profile[field]} onChange={e => setProfile({ ...profile, [field]: e.target.value })}/>}</label>)}</div>
      <label className="research-custom">自定义字段（逗号分隔）<input value={customFields} onChange={e => setCustomFields(e.target.value)} placeholder="例如：摇床转速, 碳源"/></label>
      <div className="research-profile__footer"><span>文献提取与用户实验记录分开保存；未知条件请留空。启用后可在 Agent 对话里要求搜索、提取和查询。</span><button className="button button--primary" onClick={() => void saveProfile()} disabled={!!busy}>{busy === 'profile' && <LoaderCircle className="spin" size={14}/>}保存档案</button></div>
    </section>
    <nav className="research-tabs" aria-label="研究工作区页面">{TABS.map(item => <button key={item.id} aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? 'research-tab research-tab--active' : 'research-tab'} onClick={() => setTab(item.id)}>{item.label}<span>{item.id === 'sources' ? sources.length : item.id === 'records' ? records.length : ''}</span></button>)}</nav>
    {error && <div role="alert" className="research-alert">{error}</div>}{notice && <div role="status" className="research-notice">{notice}</div>}
    {loading ? <div className="research-loading"><LoaderCircle className="spin"/>正在读取当前运行的数据…</div> : <>
      {tab === 'search' && <section className="research-card"><div className="research-card__heading"><div><strong><Search size={15}/>公开资料检索</strong><small>Europe PMC、arXiv 与 GEO 元数据</small></div></div><label className="research-field">检索词<textarea rows={3} value={query} onChange={e => setQuery(e.target.value)} placeholder="留空时根据研究档案生成基础检索式"/></label><fieldset className="research-providers"><legend>检索来源</legend>{(['europepmc','arxiv','geo'] as ResearchProvider[]).map(p => <label key={p}><input type="checkbox" checked={providers.includes(p)} onChange={e => setProviders(e.target.checked ? [...providers,p] : providers.filter(item => item !== p))}/>{p === 'europepmc' ? 'Europe PMC' : p === 'arxiv' ? 'arXiv' : 'GEO 元数据'}</label>)}</fieldset><button className="button button--primary" onClick={() => void startSearch()} disabled={!!busy}><Play size={14}/>开始检索</button>
        <div className="research-list-heading"><strong>任务记录</strong><span>检索完成仅表示来源检索结束，不代表数据已提取</span></div>
        {jobs.length === 0 ? <div className="research-empty">还没有检索任务。填写检索词或先保存研究档案，再开始检索。</div> : <div className="research-job-list">{jobs.map(job => <article className="research-job" key={job.id}><div className="research-job__main"><div><strong>{job.query || '根据研究档案生成的检索'}</strong><span className={`research-status research-status--${job.status.toLowerCase()}`}>{STATUS[job.status]}</span></div><small>{job.providers.join(' · ')}　·　找到 {job.found} 条　·　{new Date(job.updatedAt).toLocaleString('zh-CN')}</small>{job.errors.map((item,index) => <p className="research-job__error" key={index}>{item}</p>)}</div><div className="research-job__actions">{job.status === 'INTERRUPTED' && <button className="button button--quiet" onClick={() => void action(`resume:${job.id}`, async current => { const updated = await client.resumeJob(job.id); if (!current()) return; updateJob(updated); setActiveJobs(ACTIVE.has(updated.status)) })} disabled={!!busy}>恢复</button>}{ACTIVE.has(job.status) && <button className="button button--quiet" onClick={() => void action(`cancel:${job.id}`, async current => { const updated = await client.cancelJob(job.id); if (!current()) return; updateJob(updated); setActiveJobs(jobs.some(item => item.id !== updated.id && ACTIVE.has(item.status))) })} disabled={!!busy}>取消</button>}</div></article>)}</div>}
      </section>}
      {tab === 'sources' && <div className="research-columns"><section className="research-card"><div className="research-card__heading"><div><strong><BookOpen size={15}/>来源</strong><small>检索命中与已获取内容分层展示</small></div></div>{sources.length === 0 ? <div className="research-empty">尚无来源。完成一次检索后，命中记录会显示在这里。</div> : <div className="research-source-list">{sources.map(source => <article className="research-source" key={source.id}><button className="research-source__title" onClick={() => void openSource(source)}>{source.title}</button><small>{source.provider} · {source.year || '年份未知'} · {source.authors ? <a href={source.url} target="_blank" rel="noreferrer">{source.authors}</a> : `作者未知 · ${source.externalId}`}</small><div className="research-source__meta"><span className={`research-level research-level--${source.documentLevel}`}>{level(source.documentLevel)}</span><span className="research-source__links">{source.doi ? <a href={`https://doi.org/${encodeURIComponent(source.doi)}`} target="_blank" rel="noreferrer">DOI: {source.doi}</a> : <span>DOI 未知</span>}<a href={source.url} target="_blank" rel="noreferrer">来源页面</a></span></div><small className="research-source__license">许可：{source.licenseStatus === 'known' ? source.licenseUrl ? <a href={source.licenseUrl} target="_blank" rel="noreferrer">{source.license || '查看许可'}</a> : source.license || '许可信息未知' : '许可信息未知'}{source.copyright ? ` · 版权：${source.copyright}` : ''}</small><div className="research-source__actions"><button className="button button--quiet" onClick={() => void openSource(source)} disabled={!!busy}>阅读</button><button className="button button--quiet" onClick={() => void fetchSource(source)} disabled={!!busy}>{source.documentLevel === 'metadata' ? '获取摘要或正文' : '更新来源内容'}</button></div>{source.note && <p className="research-hint">{source.note}</p>}{source.fetchError && <p className="research-job__error">{source.fetchError}</p>}</article>)}</div>}</section>
        <section className="research-card research-reader"><div className="research-card__heading"><div><strong>来源正文</strong><small>{selectedSource ? `${selectedSource.provider} · ${level(selectedSource.documentLevel)}` : '选择来源后阅读'}</small></div></div>{selectedSource ? <><h3>{selectedSource.title}</h3><p className="research-reader__meta">作者：{selectedSource.authors ? <a href={selectedSource.url} target="_blank" rel="noreferrer">{selectedSource.authors}</a> : '未知'} · DOI：{selectedSource.doi ? <a href={`https://doi.org/${encodeURIComponent(selectedSource.doi)}`} target="_blank" rel="noreferrer">{selectedSource.doi}</a> : '未知'}</p><p className="research-reader__meta">许可：{selectedSource.licenseStatus === 'known' ? selectedSource.licenseUrl ? <a href={selectedSource.licenseUrl} target="_blank" rel="noreferrer">{selectedSource.license || '查看来源许可'}</a> : selectedSource.license || '许可信息未知' : '许可信息未知'}{selectedSource.copyright ? ` · 版权：${selectedSource.copyright}` : ''}</p>{selectedSource.note && <p className="research-hint">{selectedSource.note}</p>}<p className="research-reader__url"><a href={selectedSource.url} target="_blank" rel="noreferrer">{selectedSource.url}</a></p><pre>{selectedSource.text || selectedSource.abstract || '该来源尚无可阅读正文。'}</pre>{selectedSource.fetchError && <div role="alert" className="research-alert">{selectedSource.fetchError}</div>}</> : <div className="research-empty">摘要、全文和数据集元数据会标注实际获取层级。</div>}</section></div>}
      {tab === 'records' && <div className="research-columns research-columns--records"><section className="research-card"><div className="research-card__heading"><div><strong><FlaskConical size={15}/>新增文献实验记录</strong><small>仅从已获取来源录入，数值需要可定位的原文证据</small></div></div><div className="research-record-grid"><label>来源<select aria-label="来源" value={draft.sourceId} onChange={e => setDraft({ ...draft, sourceId: e.target.value })}><option value="">选择来源…</option>{sources.map(source => <option key={source.id} value={source.id}>{source.title}（{level(source.documentLevel)}）</option>)}</select></label>{(['organism','strain','medium'] as const).map(field => <label key={field}>{field === 'organism' ? '物种' : field === 'strain' ? '菌株' : '培养基'}<input value={draft[field]} onChange={e => setDraft({ ...draft, [field]: e.target.value })}/></label>)}<label>温度 (°C)<input type="number" value={draft.temperatureC} onChange={e => setDraft({ ...draft, temperatureC: e.target.value })}/></label><label>pH<input type="number" value={draft.pH} onChange={e => setDraft({ ...draft, pH: e.target.value })}/></label><label>指标<input value={draft.metric} onChange={e => setDraft({ ...draft, metric: e.target.value })}/></label><label>单位<input value={draft.unit} onChange={e => setDraft({ ...draft, unit: e.target.value })}/></label><label>时间单位<select value={draft.timeUnit} onChange={e => setDraft({ ...draft, timeUnit: e.target.value as 'h'|'min'|'s' })}><option value="h">小时 (h)</option><option value="min">分钟 (min)</option><option value="s">秒 (s)</option></select></label></div>{draft.sourceId && recordSource && !['fulltext', 'dataset'].includes(recordSource.documentLevel) && <p className="research-hint">需先获取全文或可读取的数据集内容；摘要和 GEO 元数据不能作为测量值依据。</p>}<label className="research-field">时间序列<textarea rows={5} value={draft.points} onChange={e => setDraft({ ...draft, points: e.target.value })}/><small>每行填写“时间,数值”；不确定的测量请留空，不要推算。</small></label><label className="research-field">原文证据引文<textarea rows={3} value={draft.evidenceQuote} onChange={e => setDraft({ ...draft, evidenceQuote: e.target.value })}/></label><label className="research-field">位置（页码、表格或段落）<input value={draft.locator} onChange={e => setDraft({ ...draft, locator: e.target.value })}/></label><button className="button button--primary" onClick={() => void saveRecord()} disabled={!!busy || !recordSource || !['fulltext', 'dataset'].includes(recordSource.documentLevel)}>保存记录</button></section>
        <section className="research-card"><div className="research-card__heading"><div><strong>已保存的文献记录</strong><small>这些记录来自文献，不是工业遥测或用户实测</small></div></div>{records.length === 0 ? <div className="research-empty">还没有实验记录。请从来源原文填写数值和精确引文。</div> : <div className="research-record-list">{records.map(record => <button key={record.id} className={`research-record ${selectedRecord === record.id ? 'research-record--selected' : ''}`} onClick={() => setSelectedRecord(record.id)}><strong>{record.organism || '物种未填写'} · {record.metric}</strong><small>{record.strain || '菌株未填写'} · {record.points.length} 点 · {'已提取'}</small><span>“{record.evidenceQuote}”</span><small>{record.locator}</small></button>)}</div>}<button className="button button--primary" onClick={() => void exportRecord()} disabled={!records.some(record => record.id === selectedRecord) || !!busy}><Database size={14}/>导出至生物过程建模</button><p className="research-hint">记录可先保存单个有引文依据的点；导入 growth_fit 需至少 3 个有效点，且指标为 biomass、单位为 g/L。</p></section></div>}
      {tab === 'sql' && <section className="research-card"><div className="research-card__heading"><div><strong><Table2 size={15}/>本地研究数据库查询</strong><small>只读查询当前运行中已保存的来源与记录</small></div></div><div className="research-sql-layout"><div><label className="research-field">SQL<textarea aria-label="SQL" className="research-sql-editor" rows={8} value={sql} onChange={e => setSql(e.target.value)}/></label><button className="button button--primary" onClick={() => void runQuery()} disabled={!!busy || !sql.trim()}>{busy === 'sql' ? <LoaderCircle className="spin" size={14}/> : <Play size={14}/>}运行查询</button><p className="research-hint">允许语法：SELECT 列 FROM sources|records|measurements [WHERE 列 = 值 [AND …]] [ORDER BY 列] [LIMIT n]。每次只能查询一个表，结果仅来自当前运行。</p></div><div className="research-schema"><strong>表结构</strong>{schema.map(table => <Schema key={table.name} table={table}/>)}</div></div>{result && <div className="research-query-results"><strong>查询结果 <small>{result.rows.length} 行{result.truncated ? '（已截断）' : ''}</small></strong>{result.rows.length === 0 ? <div className="research-empty">查询没有返回结果。</div> : <div className="research-table-wrap"><table><thead><tr>{result.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{result.rows.map((row,index) => <tr key={index}>{result.columns.map(column => <td key={column}>{display(row[column])}</td>)}</tr>)}</tbody></table></div>}</div>}</section>}
    </>}
  </main>
}
function Schema({ table }: { table: SchemaTable }) { return <details><summary>{table.name}</summary><ul>{table.columns.map(column => <li key={column}><code>{column}</code></li>)}</ul><small>{table.description}</small></details> }
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function level(value: Source['documentLevel']) { return ({ metadata: '仅元数据', abstract: '摘要', fulltext: '全文', dataset: '数据集元数据' } as const)[value] }
function display(value: unknown) { return value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value) }
