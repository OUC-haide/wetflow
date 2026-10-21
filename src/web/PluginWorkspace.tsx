import { useEffect, useState } from 'react'
import { Database, FileSearch, FlaskConical, Play, Plug, RefreshCw, Check, Download } from 'lucide-react'
import type { PluginId } from '../plugins/types.js'
import type { WetFlowPlugins } from '../plugins/manager.js'
import './plugin-workspace.css'

type Snapshot = ReturnType<WetFlowPlugins['snapshot']>
type Step = { stage: string; time: string; snapshot: Snapshot; probe?: unknown }
const descriptions: Record<PluginId, string> = {
  evidence: 'Retrieve imported files and cited excerpts.',
  research: 'Search literature, read sources and query records.',
  modeling: 'Run numerical models and inspect their results.',
  experiment: 'Read experiment parameters and record observations.',
  'feed-comparison': 'Compare saved MD contact reports; this extension does not run new MD simulations.',
  education: 'Search attributed education cases and prepare a WEAVE design brief.',
}
const icons = { evidence: FileSearch, research: Database, modeling: FlaskConical, experiment: Plug, 'feed-comparison': FlaskConical, education: FileSearch }
async function request<T>(url: string, method = 'GET'): Promise<T> {
  const response = await fetch(url, { method })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`)
  return body as T
}

export function PluginWorkspace() {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [steps, setSteps] = useState<Step[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [exampleResults, setExampleResults] = useState<Record<string, unknown>>({})
  const [probe, setProbe] = useState<{ available: boolean; result?: { items: Array<{ label: string; id: string }> }; error?: string }>()
  async function refresh() { setSnapshot(await request<Snapshot>('/api/plugins')) }
  useEffect(() => { void refresh().catch(cause => setError(String(cause))) }, [])
  const modules = snapshot ? [...snapshot.plugins, ...snapshot.extensions] : []
  const modeling = snapshot?.plugins.find(item => item.id === 'modeling')
  async function change(id: PluginId, action: 'load' | 'unload') {
    setBusy(true); setError(''); setProbe(undefined)
    try {
      const next = await request<Snapshot>(`/api/plugins/${id}/${action}`, 'POST')
      setSnapshot(next)
      setSteps(old => [...old, { stage: `${action === 'load' ? 'Loaded' : 'Unloaded'} ${id}`, time: new Date().toISOString(), snapshot: next }].slice(-12))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  async function callProbe() {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/plugins/modeling-probe')
      const body = await response.json()
      const result = { ...body, available: response.ok }
      setProbe(result)
      const next = await request<Snapshot>('/api/plugins')
      setSnapshot(next)
      setSteps(old => [...old, { stage: response.ok ? 'Tool call succeeded' : 'Tool unavailable', time: new Date().toISOString(), snapshot: next, probe: result }].slice(-12))
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ capturedAt: new Date().toISOString(), steps }, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = 'wetflow-plugin-session.json'; a.click(); URL.revokeObjectURL(url)
  }
  return <section className="plugin-workspace" aria-label="Plugin lifecycle workspace">
    <header className="plugin-heading"><div><h1>Give your Agent a new capability.</h1><p>Load a plugin. Watch its tools appear. Unload it to remove them.</p></div>
      <button onClick={() => void refresh().catch(cause => setError(String(cause)))} disabled={busy}><RefreshCw size={15} /> Refresh</button></header>
    <ol className="plugin-sequence" aria-label="Demonstration steps"><li>Load Modeling</li><li>Call a tool</li><li>Unload Modeling</li><li>Call again</li></ol>
    {error && <p className="plugin-error" role="alert">{error}</p>}
    <div className="plugin-columns">
      <div className="plugin-modules"><h2>Plugins</h2><p className="plugin-help">Each module owns its tools and service.</p>
        {modules.map(item => { const Icon = icons[item.id]; return <article className={`plugin-module ${item.id === 'modeling' ? 'plugin-module--focus' : ''}`} key={item.id}>
          <div className="plugin-module-title"><Icon size={19} /><h3>{item.name}</h3><span className={`plugin-status ${item.loaded ? 'is-loaded' : ''}`}>{item.loaded ? 'Loaded' : item.enabled ? 'Waiting for dependency' : 'Unloaded'}</span></div>
          <p>{descriptions[item.id]}</p>
          {item.id === 'education' && item.loaded && <button disabled={busy} onClick={async () => {
            setBusy(true); setError('')
            try { await request('/api/plugins/education/import-examples', 'POST'); await refresh() }
            catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
            finally { setBusy(false) }
          }}>Import education example sources</button>}{(item.id === 'education' || item.id === 'feed-comparison') && item.loaded && <>
            <button disabled={busy} onClick={async () => {
              setBusy(true); setError('')
              try { const result = await request(`/api/plugins/${item.id}/probe`); setExampleResults(old => ({ ...old, [item.id]: result })) }
              catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
              finally { setBusy(false) }
            }}>{item.id === 'education' ? 'Search DNA education cases' : 'Try saved feed comparison'}</button>
            {exampleResults[item.id] !== undefined && <details><summary>Tool result</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(exampleResults[item.id], null, 2)}</pre></details>}
          </>}
          <div className="plugin-module-foot"><span>{item.tools.length} tools registered</span>
            <button disabled={busy} aria-label={`${item.enabled ? 'Unload' : 'Load'} ${item.name}`} onClick={() => void change(item.id, item.enabled ? 'unload' : 'load')}>{item.enabled ? 'Unload' : 'Load'}</button></div>
        </article> })}
      </div>
      <section className="plugin-agent-tools" aria-live="polite"><div className="plugin-tools-heading"><div><h2>Agent tool registry</h2><p>{snapshot?.tools.length ?? '…'} tools available in this running instance</p></div><span className="plugin-live"><span /> Live</span></div>
        <div className="plugin-capability"><h3>Modeling tools</h3><span>{modeling?.serviceAvailable ? 'Service connected' : 'Service removed'}</span></div>
        {modeling?.tools.length ? <ul className="plugin-tool-list">{modeling.tools.map(name => <li key={name}><Check size={14} /><code>{name}</code></li>)}</ul> : <div className="plugin-empty"><FlaskConical size={30} /><strong>No modeling tools registered</strong><p>Load Modeling Plugin to make its methods available to the Agent.</p></div>}
        <div className="plugin-probe"><button disabled={busy || !snapshot} onClick={() => void callProbe()}><Play size={14} /> Call modeling_methods</button><p>Invokes the actual registered tool.</p></div>
        {probe && <div className={`plugin-probe-result ${probe.available ? 'is-available' : ''}`} role="status"><strong>{probe.available ? 'Tool executed successfully' : 'Tool is no longer available'}</strong>
          {probe.available ? <ul>{probe.result?.items.map(item => <li key={item.id}>{item.label} <code>{item.id}</code></li>)}</ul> : <p>It has been removed from the registry. Loading the plugin restores this capability.</p>}</div>}
        <details className="plugin-other-tools"><summary>Other registered tools ({(snapshot?.tools.length ?? 0) - (modeling?.tools.length ?? 0)})</summary><ul>{snapshot?.tools.filter(name => !modeling?.tools.includes(name)).map(name => <li key={name}><code>{name}</code></li>)}</ul></details>
      </section>
    </div>
    <section className="plugin-trace"><div className="plugin-trace-heading"><h2>This session</h2><button onClick={download} disabled={!steps.length}><Download size={14} /> Export actual results</button></div>
      {steps.length ? <div className="plugin-trace-scroll"><table><thead><tr><th>Action</th><th>Modeling service</th><th>Modeling tools</th><th>All Agent tools</th></tr></thead><tbody>{steps.map((step, i) => { const item = step.snapshot.plugins.find(p => p.id === 'modeling'); return <tr key={i}><td>{step.stage}</td><td>{item?.serviceAvailable ? 'Available' : 'Unavailable'}</td><td>{item?.tools.length}</td><td>{step.snapshot.tools.length}</td></tr> })}</tbody></table></div> : <p className="plugin-help">Your operations and their measured registry state will appear here.</p>}
    </section>
  </section>
}
