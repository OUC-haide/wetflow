import { useEffect, useRef, useState } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import { MAX_IMPORT_FILE_BYTES } from '../../batch-data/import-types.js'
import type { ImportDocument, ImportMapping } from '../../batch-data/import-types.js'
import type { ImportPreview, Metric } from '../../batch-data/types.js'
import { guessImportMapping, mappedImportCsv } from '../../batch-data/import-mapping.js'

interface Props {
  batchId: string
  metrics: Metric[]
  request<T>(path: string, body?: unknown): Promise<T>
  onComplete(result: { inserted: number; skipped: number }): void
}
function dataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('无法读取所选文件，请重新选择。'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })
}
export function BatchFileImport({ batchId, metrics, request, onComplete }: Props) {
  const [document, setDocument] = useState<ImportDocument | null>(null)
  const [tableId, setTableId] = useState(''), [mapping, setMapping] = useState<ImportMapping | null>(null)
  const [csv, setCsv] = useState(''), [preview, setPreview] = useState<ImportPreview | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [filename, setFilename] = useState('')
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const table = document?.tables.find(x => x.id === tableId)
  const columns = table ? Math.max(...table.rows.map(row => row.cells.length)) : 0
  const labels = Array.from({ length: columns }, (_, i) => `${i + 1} · ${table?.rows[mapping?.headerRow ?? 0]?.cells[i] || '无列名'}`)
  const invalidate = () => { setCsv(''); setPreview(null); setError('') }
  const change = (patch: Partial<ImportMapping>) => { invalidate(); setMapping(old => old ? { ...old, ...patch } : old) }
  async function selectFile(file: File) {
    const current = ++generation.current
    setBusy(true); invalidate(); setDocument(null); setMapping(null); setFilename(file.name)
    try {
      if (/\.csv$/i.test(file.name)) {
        if (file.size > 1_000_000) throw new Error('CSV 最多 1 MB。')
        const text = await file.text()
        if (current === generation.current) setCsv(text)
      } else {
        if (!/\.(xlsx|pdf)$/i.test(file.name)) throw new Error('请选择 CSV、Excel（.xlsx）或 PDF 文件。')
        if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Excel / PDF 文件最多 10 MiB，请先拆分。')
        const result = await request<ImportDocument>('/import/file', { batchId, name: file.name, dataUrl: await dataUrl(file) })
        if (current !== generation.current) return
        setDocument(result); setTableId(result.tables[0]!.id); setMapping(guessImportMapping(result.tables[0]!, metrics))
      }
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  async function validate() {
    const current = ++generation.current
    setBusy(true); setError(''); setPreview(null)
    try {
      const result = await request<ImportPreview>('/import/preview', { batchId, csv })
      if (current === generation.current) setPreview(result)
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  async function save() {
    setBusy(true); setError('')
    try { onComplete(await request<{ inserted: number; skipped: number }>('/import', { batchId, csv })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setPreview(null) }
    finally { setBusy(false) }
  }
  const columnPicker = (title: string, key: 'sample' | 'value' | 'metric' | 'unit' | 'note' | 'sampledAt', empty: string) => <label>{title}<select aria-label={title} disabled={busy} value={mapping?.[key] ?? -1} onChange={e => change({ [key]: Number(e.target.value) })}><option value={-1}>{empty}</option>{labels.map((label, index) => <option key={index} value={index}>{label}</option>)}</select></label>
  return <div className="batch-form batch-file-import">
    <p>选择文件，核对表格和列对应关系，再校验导入。每次写入当前批次；Excel 可选择工作表，PDF 可选择页面。</p>
    <div className="batch-actions"><label className="batch-file">选择文件<input type="file" disabled={busy} accept=".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="选择数据文件" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void selectFile(file) }}/></label>
      <a className="batch-template" download="batch-import-template.csv" href="data:text/csv;charset=utf-8,%EF%BB%BFsample%2Cmetric%2Cvalue%2Cunit%2Csource%2Clocator%2CsampledAt%2Cnote%0D%0A"><Download size={14}/>下载 CSV 空模板</a></div>
    {busy && <p role="status"><LoaderCircle className="spin" size={14}/> 正在处理，请稍候…</p>}
    {error && <p className="batch-feedback is-error" role="alert">{error}</p>}
    {document && table && mapping && <>
      <label>{document.format === 'xlsx' ? '工作表' : 'PDF 页面'}<select disabled={busy} value={tableId} onChange={e => { invalidate(); setTableId(e.target.value); setMapping(guessImportMapping(document.tables.find(x => x.id === e.target.value)!, metrics)) }}>{document.tables.map(item => <option key={item.id} value={item.id}>{item.label} · {item.rows.length} 行</option>)}</select></label>
      {document.warnings.length > 0 && <div className="batch-file-notes">{document.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>}
      <div className="batch-form-row"><label>表头行<select disabled={busy} value={mapping.headerRow} onChange={e => { invalidate(); setMapping(guessImportMapping(table, metrics, Number(e.target.value))) }}>{table.rows.map((row, i) => <option key={i} value={i}>第 {i + 1} 行 · {row.cells.join(' / ').slice(0, 80)}</option>)}</select></label><label>表格形式<select disabled={busy} value={mapping.mode} onChange={e => change({ mode: e.target.value as 'long' | 'wide' })}><option value="wide">每项指标各占一列</option><option value="long">指标、数值分别占一列</option></select></label></div>
      <div className="batch-form-row"><label>数据起始行<input type="number" min={1} max={table.rows.length} disabled={busy} value={mapping.startRow + 1} onChange={e => change({ startRow: Number(e.target.value) - 1 })}/></label><label>数据结束行<input type="number" min={1} max={table.rows.length} disabled={busy} value={mapping.endRow + 1} onChange={e => change({ endRow: Number(e.target.value) - 1 })}/></label></div>
      <p>下方显示表头及所选范围的前 12 行；行号按预览计数，原始文件位置会随记录保存。</p>
      <div className="batch-table-wrap batch-source-preview"><table><thead><tr><th>预览行</th>{labels.map((label, i) => <th key={i}>{label}</th>)}</tr></thead><tbody>{table.rows.slice(Math.max(0, mapping.startRow), Math.min(table.rows.length, mapping.endRow + 1, Math.max(0, mapping.startRow) + 12)).map((row, i) => <tr key={i}><td title={row.locator}>{Math.max(0, mapping.startRow) + i + 1}</td>{labels.map((_, j) => <td key={j}>{row.cells[j] || '—'}</td>)}</tr>)}</tbody></table></div>
      {columnPicker('采样点列', 'sample', '请选择采样点列')}
      {mapping.mode === 'long' ? <>
        <div className="batch-form-row">{columnPicker('数值列', 'value', '请选择数值列')}{columnPicker('指标列', 'metric', '本次使用同一指标')}</div>
        {mapping.metric < 0 && <label>本次指标<select disabled={busy} value={mapping.fixedMetric} onChange={e => change({ fixedMetric: e.target.value })}><option value="">请选择指标</option>{metrics.map(item => <option key={item.id} value={item.code}>{item.name} · {item.code} ({item.unit || '无量纲'})</option>)}</select></label>}
        {columnPicker('单位列', 'unit', '使用对应指标的已定义单位（请核对）')}
      </> : <div className="batch-column-mapping"><p>为需要导入的数值列选择指标。空白数值不会补零；列名带单位时会一并校验。</p>{labels.map((label, i) => i === mapping.sample ? null : <label key={i}><span>{label}</span><select disabled={busy} aria-label={`第 ${i + 1} 列对应指标`} value={mapping.wideMetrics[i] ?? ''} onChange={e => change({ wideMetrics: { ...mapping.wideMetrics, [i]: e.target.value } })}><option value="">不导入此列</option>{metrics.map(item => <option key={item.id} value={item.code}>{item.name} · {item.code} ({item.unit || '无量纲'})</option>)}</select></label>)}</div>}
      <div className="batch-form-row">{columnPicker('备注列', 'note', '不使用')}{columnPicker('采样时间列', 'sampledAt', '不使用')}</div>
      <p>没有单位列或表头单位时，使用所选指标的已定义单位。请先确认文件中的实际单位。</p>
      <button disabled={busy} onClick={() => { setError(''); setPreview(null); try { setCsv(mappedImportCsv(document, table, mapping, metrics)) } catch (cause) { setCsv(''); setError(cause instanceof Error ? cause.message : String(cause)) } }}>生成待导入记录</button>
    </>}
    {(!document || csv) && <label>{document ? '待导入记录（可修正后再校验）' : 'CSV 内容'}<textarea aria-label="待导入 CSV" disabled={busy} rows={7} value={csv} placeholder="选择文件，或粘贴包含 sample,metric,value,unit,source 列的 CSV" onChange={e => { generation.current++; setCsv(e.target.value); setPreview(null); setError('') }}/></label>}
    {csv && <p>{filename && `文件：${filename}。`}保留原始数值；正式写入前会校验指标、单位、重复记录和冲突。</p>}
    {preview && <div className="batch-import-preview"><strong>新增 {preview.newCount} · 重复 {preview.duplicateCount} · 错误 {preview.errorCount}</strong><div>{preview.rows.map(row => <p key={row.line} className={row.status === 'error' ? 'is-error' : ''}>第 {row.line} 行：{row.message}</p>)}</div></div>}
    <footer><button disabled={busy || !csv} onClick={() => void validate()}>校验预览</button><button className="batch-primary" disabled={busy || !preview || !!preview.errorCount || !preview.newCount} onClick={() => void save()}>确认导入</button></footer>
  </div>
}
