import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowLeftRight, Check, ChevronRight, Database, Download, History, Layers3, LoaderCircle, Plus, RefreshCw, Search, Upload, X } from 'lucide-react'
import type { Catalogue, Comparison, ImportPreview, Observation, RecordPage, Revision } from '../../batch-data/types.js'
import './batch-data.css'

type Modal = 'round' | 'batch' | 'metric' | 'record' | 'import' | 'history' | null
const empty: Catalogue = { rounds: [], batches: [], metrics: [], recordCount: 0 }
function download(name: string, value: string) {
  const url = URL.createObjectURL(new Blob([value], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
}
export function BatchDataWorkspace({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose(): void }) {
  const [catalog, setCatalog] = useState<Catalogue>(empty)
  const [selected, setSelected] = useState('')
  const [metric, setMetric] = useState('')
  const [sample, setSample] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [storedPage, setPage] = useState<RecordPage>({ items: [], total: 0, offset: 0, limit: 100 })
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [modal, setModal] = useState<Modal>(null)
  const [round, setRound] = useState(''), [recordMetric, setRecordMetric] = useState('')
  const [csv, setCsv] = useState(''), [preview, setPreview] = useState<ImportPreview | null>(null)
  const [record, setRecord] = useState<Observation | null>(null), [history, setHistory] = useState<Revision[]>([])
  const [compareMode, setCompareMode] = useState(false), [rightId, setRightId] = useState('')
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [revision, setRevision] = useState(0)
  const [pageKey, setPageKey] = useState('')
  const queryKey = JSON.stringify([selected, metric, sample, offset, revision])
  const page = pageKey === queryKey ? storedPage : { items: [], total: 0, offset: 0, limit: 100 }
  const modalRef = useRef<HTMLDivElement>(null), previousFocus = useRef<HTMLElement | null>(null)
  const request = useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch('/api/batch-data' + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'x-wetflow-project': projectId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? '请求失败，请重试。')
    return data as T
  }, [projectId])
  const refresh = useCallback(async () => { const data = await request<Catalogue>('/catalog'); setCatalog(data); return data }, [request])
  useEffect(() => {
    let live = true
    setLoading(true)
    void request<Catalogue>('/catalog').then(data => { if (live) { setCatalog(data); setSelected(old => old || data.batches[0]?.id || '') } })
      .catch(cause => { if (live) setError(String(cause.message ?? cause)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [request, revision])
  useEffect(() => {
    let live = true
    setComparison(null)
    if (!selected) { setPage({ items: [], total: 0, offset: 0, limit: 100 }); return }
    const params = new URLSearchParams({ batchId: selected, offset: String(offset) })
    if (metric) params.set('metricId', metric)
    if (sample) params.set('sample', sample)
    void request<RecordPage>('/records?' + params).then(data => { if (live) { setPage(data); setPageKey(queryKey) } }).catch(cause => { if (live) setError(cause.message) })
    return () => { live = false }
  }, [request, selected, metric, sample, offset, revision, queryKey])
  useEffect(() => {
    if (!modal) return
    previousFocus.current = document.activeElement as HTMLElement | null
    modalRef.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus()
    return () => { previousFocus.current?.focus() }
  }, [modal])
  const batch = catalog.batches.find(b => b.id === selected)
  const selectedRound = catalog.rounds.find(r => r.id === batch?.roundId)
  const metricInfo = catalog.metrics.find(m => m.id === recordMetric)
  const open = (name: Modal) => { setError(''); setNotice(''); setRound(selectedRound?.id || catalog.rounds[0]?.id || ''); setRecordMetric(catalog.metrics[0]?.id || ''); setCsv(''); setPreview(null); setModal(name) }
  const act = async (f: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await f() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget), value = (name: string) => String(data.get(name) ?? '').trim()
    await act(async () => {
      if (modal === 'round') {
        const added = await request<{ id: string }>('/rounds', { name: value('name'), number: Number(value('number')), note: value('note') })
        await refresh(); setRound(added.id); setModal('batch'); return
      }
      if (modal === 'batch') {
        const added = await request<{ id: string }>('/batches', { roundId: round, code: value('code'), name: value('name'), conditions: value('conditions') })
        setSelected(added.id); setOffset(0)
      }
      if (modal === 'metric') await request('/metrics', { code: value('code'), name: value('name'), unit: value('unit'), lower: value('lower') || null, upper: value('upper') || null })
      const fields = { value: value('value'), unit: modal === 'history' ? record!.unit : metricInfo?.unit ?? '', source: value('source'), locator: value('locator'), note: value('note'), sampledAt: value('sampledAt') || null }
      if (modal === 'record') await request('/records', { ...fields, batchId: selected, metricId: recordMetric, sample: value('sample') })
      if (modal === 'history' && record) await request(`/records/${record.id}/correct`, { ...fields, expectedRevision: record.revision, reason: value('reason') })
      setModal(null); setRevision(v => v + 1); setNotice('已保存。')
    })
  }
  const showHistory = (item: Observation) => void act(async () => {
    setRecord(item); setHistory(await request<Revision[]>(`/records/${item.id}/history`)); setModal('history')
  })
  const metricName = (id: string) => catalog.metrics.find(m => m.id === id)?.name ?? id
  const batchName = (id: string) => { const b = catalog.batches.find(b => b.id === id); const r = catalog.rounds.find(r => r.id === b?.roundId); return `第 ${r?.number ?? '?'} 轮 / ${b?.code ?? ''} ${b?.name ?? ''}` }
  return <section className="batch-workspace" aria-label="多批次数据库">
    <header className="batch-heading"><div className="batch-heading-title"><Database size={23}/><div><h1>多批次数据</h1><p>{projectName} <span>按轮次积累，按来源核对</span></p></div></div>
      <div className="batch-actions"><button disabled={busy} onClick={() => setRevision(v => v + 1)} aria-label="刷新数据库"><RefreshCw size={15}/></button><button onClick={onClose}><ArrowLeft size={15}/>返回对话</button></div></header>
    {error && <p className="batch-feedback is-error" role="alert">{error}</p>}
    {notice && <p className="batch-feedback" role="status"><Check size={14}/>{notice}</p>}
    <div className="batch-layout">
      <aside className="batch-tree" aria-label="轮次与批次">
        <div className="batch-tree-heading"><strong>轮次与批次</strong><button title="新建轮次" aria-label="新建轮次" onClick={() => open('round')}><Plus size={17}/></button></div>
        <label className="batch-search"><Search size={14}/><input aria-label="筛选轮次与批次" placeholder="查找批次" value={search} onChange={e => setSearch(e.target.value)}/></label>
        {catalog.rounds.map(r => {
          const batches = catalog.batches.filter(b => b.roundId === r.id && `${b.code} ${b.name} ${r.name}`.toLowerCase().includes(search.toLowerCase()))
          if (search && !batches.length) return null
          return <section className="batch-round" key={r.id}><div><Layers3 size={14}/><strong>第 {r.number} 轮</strong><span>{r.name}</span></div>
            {batches.map(b => <button key={b.id} className={selected === b.id ? 'is-selected' : ''} aria-pressed={selected === b.id}
              onClick={() => { setSelected(b.id); setOffset(0); setComparison(null); setNotice('') }}><span><strong>{b.code}</strong><small>{b.name}</small></span><ChevronRight size={13}/></button>)}
            <button className="batch-add" onClick={() => { open('batch'); setRound(r.id) }}><Plus size={13}/>添加批次</button>
          </section>
        })}
        {!catalog.rounds.length && !loading && <p className="batch-subtle">先建立一轮记录，再添加本轮的批次。</p>}
        <footer><span>{catalog.rounds.length} 轮</span><span>{catalog.batches.length} 批次</span><span>{catalog.recordCount} 条记录</span></footer>
      </aside>
      <div className="batch-main">
        {loading ? <div className="batch-empty"><LoaderCircle className="spin"/><p>正在读取数据库</p></div> : !batch ? <div className="batch-empty"><Database size={36}/><h2>把下一轮数据接着存下来</h2><p>每个批次独立保留条件、采样记录和来源。录入后的修正也可以逐条回看。</p><button className="batch-primary" onClick={() => open(catalog.rounds.length ? 'batch' : 'round')}><Plus size={16}/>{catalog.rounds.length ? '添加批次' : '建立第一轮'}</button></div> : <>
          <div className="batch-title"><div><span>第 {selectedRound?.number} 轮 / {selectedRound?.name}</span><h2>{batch.code} <span>{batch.name}</span></h2><p>{batch.conditions || '尚未填写批次条件'}</p></div>
            <button onClick={() => open('batch')}><Plus size={14}/>新批次</button></div>
          <div className="batch-toolbar"><div className="batch-tabs"><button className={!compareMode ? 'is-active' : ''} onClick={() => setCompareMode(false)}>数据明细</button><button className={compareMode ? 'is-active' : ''} onClick={() => { setCompareMode(true); setComparison(null) }}><ArrowLeftRight size={14}/>跨批次对比</button></div>
            <div className="batch-actions"><button onClick={() => open('metric')}><Plus size={14}/>定义指标</button><button disabled={busy} onClick={() => void act(async () => { const result = await request<{ csv: string }>('/export?batchId=' + selected); download(`batch-${batch.code}.csv`, result.csv) })}><Download size={14}/>导出</button></div></div>
          {!compareMode ? <>
            <div className="batch-filters"><label>指标<select value={metric} onChange={e => { setMetric(e.target.value); setOffset(0) }}><option value="">全部指标</option>{catalog.metrics.map(m => <option key={m.id} value={m.id}>{m.name} ({m.unit || '无量纲'})</option>)}</select></label><label>采样点<input aria-label="精确筛选采样点" placeholder="完整名称" value={sample} onChange={e => { setSample(e.target.value); setOffset(0) }}/></label>
              <div className="batch-actions"><button disabled={!catalog.metrics.length} onClick={() => open('import')}><Upload size={14}/>导入 CSV</button><button className="batch-primary" disabled={!catalog.metrics.length} onClick={() => open('record')}><Plus size={14}/>录入数据</button></div></div>
            {!catalog.metrics.length && <div className="batch-inline-empty">先<button onClick={() => open('metric')}>定义指标和单位</button>，再录入或导入本批次数据。</div>}
            <div className="batch-table-wrap"><table><thead><tr><th>采样点</th><th>指标</th><th className="batch-number">原始值</th><th>单位</th><th>来源与位置</th><th>状态</th><th>版本</th></tr></thead><tbody>
              {page.items.map(item => <tr key={item.id}><td><strong>{item.sample}</strong>{item.sampledAt && <small>{item.sampledAt}</small>}</td><td>{metricName(item.metricId)}</td><td className="batch-number">{item.value}</td><td>{item.unit || '—'}</td><td><span>{item.source}</span><small>{item.locator || '未标注位置'}</small></td><td><span className={`batch-status ${item.deviation ? 'is-deviation' : ''}`}>{item.deviation ? '偏差待复核' : '已记录'}</span></td><td><button className="batch-history" disabled={busy} aria-label={`查看 ${item.sample} ${metricName(item.metricId)} 历史`} onClick={() => showHistory(item)}><History size={13}/>v{item.revision}</button></td></tr>)}
            </tbody></table>{!page.items.length && <div className="batch-inline-empty">{sample || metric ? '没有符合当前筛选条件的记录。' : '本批次还没有数据。可以手动录入，也可以预览并导入 CSV。'}</div>}</div>
            <div className="batch-pagination"><span>共 {page.total} 条{page.total ? `，当前 ${offset + 1}–${offset + page.items.length}` : ''}</span><div><button disabled={!offset} onClick={() => setOffset(v => Math.max(0, v - 100))}>上一页</button><button disabled={offset + 100 >= page.total} onClick={() => setOffset(v => v + 100)}>下一页</button></div></div>
          </> : <>
            <div className="batch-compare-picker"><label>基准批次<strong>{batchName(selected)}</strong></label><ArrowLeftRight size={18}/><label>对比批次<select aria-label="对比批次" value={rightId} onChange={e => { setRightId(e.target.value); setComparison(null) }}><option value="">选择另一个批次</option>{catalog.batches.filter(b => b.id !== selected).map(b => <option key={b.id} value={b.id}>{batchName(b.id)}</option>)}</select></label><button className="batch-primary" disabled={busy || !rightId || rightId === selected} onClick={() => void act(async () => setComparison(await request<Comparison>(`/compare?leftId=${selected}&rightId=${rightId}`)))}>对比数据</button></div>
            <p className="batch-subtle">按相同指标和采样点配对；差值 = 对比批次 − 基准批次。缺失数据保留为空。请结合两批的条件判断是否适合比较。</p>
            {comparison && comparison.left.id === selected && comparison.right.id === rightId && <><div className="batch-compare-conditions"><p><strong>{comparison.left.code}</strong>{comparison.left.conditions || '未填写条件'}</p><p><strong>{comparison.right.code}</strong>{comparison.right.conditions || '未填写条件'}</p></div><p className="batch-subtle">已配对 {comparison.matched} 项，缺失 {comparison.missing} 项</p><div className="batch-table-wrap"><table><thead><tr><th>采样点</th><th>指标 / 单位</th><th className="batch-number">{comparison.left.code}</th><th className="batch-number">{comparison.right.code}</th><th className="batch-number">差值</th></tr></thead><tbody>{comparison.items.map(item => <tr key={item.metric.id + item.sample}><td>{item.sample}</td><td>{item.metric.name}<small>{item.metric.unit || '无量纲'}</small></td><td className="batch-number">{item.left?.value ?? '缺失'}{item.left?.deviation && <small>偏差待复核</small>}</td><td className="batch-number">{item.right?.value ?? '缺失'}{item.right?.deviation && <small>偏差待复核</small>}</td><td className="batch-number">{item.delta ?? '—'}</td></tr>)}</tbody></table></div></>}
          </>}
        </>}
      </div>
    </div>
    {modal && <div className="batch-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setModal(null) }}><div className="batch-modal" role="dialog" aria-modal="true" aria-labelledby="batch-modal-title" ref={modalRef} onKeyDown={e => {
      if (e.key === 'Escape' && !busy) setModal(null)
      if (e.key === 'Tab') {
        const nodes = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')]
        const first = nodes[0], last = nodes.at(-1)
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }}><header><h2 id="batch-modal-title">{{ round: '建立新一轮', batch: '添加批次', metric: '定义指标', record: '录入采样数据', import: '预览并导入 CSV', history: '记录与修正历史' }[modal]}</h2><button disabled={busy} onClick={() => setModal(null)} aria-label="关闭数据窗口"><X size={18}/></button></header>
      {error && <p className="batch-feedback is-error" role="alert">{error}</p>}
      {modal === 'import' ? <div className="batch-form"><p>先定义 CSV 中使用的指标。列名为 sample, metric, value, unit, source, locator, sampledAt, note；前五列必填。sampledAt 使用带时区的 ISO 时间，可留空。</p><div className="batch-actions"><button onClick={() => download('batch-import-template.csv', 'sample,metric,value,unit,source,locator,sampledAt,note\r\n')}><Download size={14}/>下载空模板</button><label className="batch-file">选择 CSV<input type="file" accept=".csv,text/csv" aria-label="选择 CSV 文件" onChange={e => { const f = e.target.files?.[0]; if (f) void act(async () => { if (f.size > 1000000) throw new Error('CSV 最多 1 MB。'); setCsv(await f.text()); setPreview(null) }) }}/></label></div>
        <label>CSV 内容<textarea rows={9} value={csv} onChange={e => { setCsv(e.target.value); setPreview(null) }}/></label>
        {preview && <div className="batch-import-preview"><strong>新增 {preview.newCount} · 重复 {preview.duplicateCount} · 错误 {preview.errorCount}</strong><div>{preview.rows.map(row => <p key={row.line} className={row.status === 'error' ? 'is-error' : ''}>第 {row.line} 行：{row.message}</p>)}</div></div>}
        <footer><button disabled={busy || !csv} onClick={() => void act(async () => setPreview(await request<ImportPreview>('/import/preview', { batchId: selected, csv })))}>校验预览</button><button className="batch-primary" disabled={busy || !preview || !!preview.errorCount || !preview.newCount} onClick={() => void act(async () => { const result = await request<{ inserted: number; skipped: number }>('/import', { batchId: selected, csv }); setNotice(`已导入 ${result.inserted} 条，跳过 ${result.skipped} 条重复记录。`); setModal(null); setRevision(v => v + 1) })}>确认导入</button></footer></div> : <form className="batch-form" onSubmit={e => void submit(e)}>
        {modal === 'round' && <><label>轮次编号<input name="number" type="number" min="1" required defaultValue={Math.max(0, ...catalog.rounds.map(r => r.number)) + 1}/></label><label>轮次名称<input name="name" required maxLength={120} placeholder="本轮要做什么"/></label><label>说明<textarea name="note" rows={3} maxLength={2000}/></label></>}
        {modal === 'batch' && <><label>所属轮次<select value={round} onChange={e => setRound(e.target.value)} required><option value="">请选择轮次</option>{catalog.rounds.map(r => <option key={r.id} value={r.id}>第 {r.number} 轮 · {r.name}</option>)}</select></label><label>批次编号<input name="code" required maxLength={120} placeholder="例如 B-01"/></label><label>批次名称<input name="name" required maxLength={120}/></label><label>本批条件与说明<textarea name="conditions" rows={4} maxLength={2000} placeholder="填写本批次的条件，方便之后对照"/></label></>}
        {modal === 'metric' && <><label>指标代码<input name="code" required pattern="[A-Za-z][A-Za-z0-9_-]{0,39}" placeholder="例如 TEMP"/></label><label>显示名称<input name="name" required maxLength={120}/></label><label>固定单位<input name="unit" maxLength={40} placeholder="例如 °C；无量纲可留空"/></label><div className="batch-form-row"><label>正常下限<input name="lower" inputMode="decimal" placeholder="可选"/></label><label>正常上限<input name="upper" inputMode="decimal" placeholder="可选"/></label></div><p>单位确定后，每次写入都会校验。超出正常范围的读数保留原值，并标记供复核。</p></>}
        {modal === 'record' && <><label>指标<select aria-label="指标" required value={recordMetric} onChange={e => setRecordMetric(e.target.value)}>{catalog.metrics.map(m => <option key={m.id} value={m.id}>{m.name} ({m.unit || '无量纲'})</option>)}</select></label><label>采样点<input name="sample" required maxLength={120} placeholder="例如 T1 或 24 h；各批次用同一命名"/></label></>}
        {modal === 'history' && record && <><p><strong>{record.sample} / {metricName(record.metricId)}</strong> · 当前 v{record.revision}</p><div className="batch-revisions">{history.map(h => <article key={h.revision}><div><strong>v{h.revision} · {h.data.value} {h.data.unit}</strong><time>{new Date(h.at).toLocaleString('zh-CN')}</time></div><p>{h.reason}</p><small>{h.data.source} {h.data.locator} · {h.actor === 'agent-approved' ? 'Agent 提议，用户批准' : '用户录入'}</small></article>)}</div><h3>修正这条记录</h3><p>旧值和来源会保留。修正不会改动所属批次、指标和采样点。</p></>}
        {(modal === 'record' || modal === 'history') && <><label>数值 ({modal === 'history' ? record?.unit || '无量纲' : metricInfo?.unit || '无量纲'})<input name="value" required inputMode="decimal" defaultValue={modal === 'history' ? record?.value : ''} placeholder="保留原始小数位"/></label><label>来源<input name="source" required maxLength={600} defaultValue={modal === 'history' ? record?.source : ''} placeholder="文件名、仪器记录或操作记录"/></label><label>来源位置<input name="locator" maxLength={300} defaultValue={modal === 'history' ? record?.locator : ''} placeholder="页码 / 行号 / 样品编号"/></label><label>采样时间（可选）<input name="sampledAt" defaultValue={modal === 'history' ? record?.sampledAt ?? '' : ''} placeholder="2026-10-28T09:00:00+08:00"/></label><label>备注<textarea name="note" rows={2} defaultValue={modal === 'history' ? record?.note : ''}/></label></>}
        {modal === 'history' && <label>修正原因<input name="reason" required maxLength={1000} placeholder="说明为什么需要修正"/></label>}
        <footer><button type="button" disabled={busy} onClick={() => setModal(null)}>取消</button><button className="batch-primary" disabled={busy} type="submit">{busy ? <LoaderCircle className="spin" size={14}/> : <Check size={14}/>} {modal === 'round' ? '保存并添加批次' : modal === 'history' ? '保存修正' : '保存'}</button></footer>
      </form>}
    </div></div>}
  </section>
}
