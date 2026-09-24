export type ResearchProvider = 'europepmc' | 'arxiv' | 'geo'
export type JobStatus = 'QUEUED' | 'SEARCHING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'
export interface Profile { runId: string; enabled: boolean; goal: string; organism: string; strain: string; metric: string; conditions: string; customFields: string[] }
export interface SearchHit { provider: ResearchProvider; externalId: string; title: string; url: string; doi?: string; authors?: string; year?: string; abstract?: string; pmcid?: string; accession?: string }
export interface Job { id: string; runId: string; query: string; providers: ResearchProvider[]; status: JobStatus; found: number; errors: string[]; createdAt: string; updatedAt: string }
export interface Source extends SearchHit { id: string; runId: string; documentLevel: 'metadata' | 'abstract' | 'fulltext' | 'dataset'; text: string; note?: string; fetchError?: string }
export interface Point { time: number; value: number }
export interface ResearchRecord { id: string; runId: string; sourceId: string; createdAt: string; origin: 'literature'; status: 'EXTRACTED'; organism: string; strain: string; medium: string; temperatureC?: number; pH?: number; metric: string; unit: string; points: Point[]; timeUnit: 'h' | 'min' | 's'; evidenceQuote: string; locator: string; custom?: Record<string, string> }
export interface SchemaTable { name: string; columns: string[]; description: string }
export interface QueryResult { columns: string[]; rows: Array<Record<string, unknown>>; truncated: boolean }

export class ResearchApiError extends Error { constructor(message: string, readonly status: number) { super(message); this.name = 'ResearchApiError' } }
export function isResearchAbort(error: unknown): boolean { return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError' }
async function decode<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `请求失败 (${response.status})`
    try { const body = await response.json() as { error?: unknown }; if (typeof body.error === 'string' && body.error) message = body.error } catch { /* status fallback */ }
    throw new ResearchApiError(message, response.status)
  }
  return await response.json() as T
}
export class ResearchClient {
  constructor(private readonly runId: string, private readonly base = '/api/research') {}
  private url(path: string) { return `${this.base}${path}${path.includes('?') ? '&' : '?'}runId=${encodeURIComponent(this.runId)}` }
  private async read<T>(path: string, signal?: AbortSignal): Promise<T> { return decode<T>(await fetch(this.url(path), signal ? { signal } : {})) }
  private async write<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return decode<T>(await fetch(`${this.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: this.runId, ...body }), ...(signal ? { signal } : {}) }))
  }
  profile(signal?: AbortSignal) { return this.read<Profile>('/profile', signal) }
  saveProfile(profile: Omit<Profile, 'runId'>, signal?: AbortSignal) { return fetch(`${this.base}/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: this.runId, ...profile }), ...(signal ? { signal } : {}) }).then(response => decode<Profile>(response)) }
  jobs(signal?: AbortSignal) { return this.read<{ items: Job[] }>('/jobs', signal) }
  startJob(query: string, providers: ResearchProvider[], signal?: AbortSignal) { return this.write<Job>('/jobs', { ...(query.trim() ? { query: query.trim() } : {}), providers, limit: 20 }, signal) }
  resumeJob(id: string, signal?: AbortSignal) { return this.write<Job>(`/jobs/${encodeURIComponent(id)}/resume`, {}, signal) }
  cancelJob(id: string, signal?: AbortSignal) { return this.write<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, {}, signal) }
  sources(signal?: AbortSignal) { return this.read<{ items: Source[] }>('/sources', signal) }
  source(id: string, signal?: AbortSignal) { return this.read<Source>(`/sources/${encodeURIComponent(id)}`, signal) }
  fetchSource(id: string, signal?: AbortSignal) { return this.write<Source>(`/sources/${encodeURIComponent(id)}/fetch`, {}, signal) }
  records(signal?: AbortSignal) { return this.read<{ items: ResearchRecord[] }>('/records', signal) }
  addRecord(input: Omit<ResearchRecord, 'id' | 'runId' | 'createdAt' | 'origin' | 'status'>, signal?: AbortSignal) { return this.write<ResearchRecord>('/records', input as unknown as Record<string, unknown>, signal) }
  schema(signal?: AbortSignal) { return this.read<{ tables: SchemaTable[] }>('/schema', signal) }
  query(sql: string, signal?: AbortSignal) { return this.write<QueryResult>('/query', { sql }, signal) }
  exportModeling(id: string, signal?: AbortSignal) { return this.write<{ datasetId: string; name: string }>(`/records/${encodeURIComponent(id)}/export-modeling`, {}, signal) }
}
