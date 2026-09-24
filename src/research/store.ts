import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ResearchJob, ResearchJobStatus, ResearchProfile, ResearchRecord, ResearchSource } from './types.js'
import type { ResearchProvider } from './providers.js'

const time = () => new Date().toISOString()
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T

/** A separate SQLite file holds only research evidence; every row is owned by a workflow run. */
export class ResearchStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS research_profiles(run_id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_jobs(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, query TEXT NOT NULL, providers TEXT NOT NULL, status TEXT NOT NULL, found INTEGER NOT NULL, errors TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, search_limit INTEGER NOT NULL DEFAULT 10);
      CREATE INDEX IF NOT EXISTS research_jobs_run ON research_jobs(run_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS research_sources(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, doi TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id,provider,external_id));
      CREATE INDEX IF NOT EXISTS research_source_doi ON research_sources(run_id, doi);
      CREATE TABLE IF NOT EXISTS research_records(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES research_sources(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS research_records_run ON research_records(run_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS research_exports(run_id TEXT NOT NULL, record_id TEXT NOT NULL, dataset_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id,record_id,dataset_id));` )
    this.db.prepare("UPDATE research_jobs SET status='INTERRUPTED',updated_at=? WHERE status IN ('QUEUED','SEARCHING')").run(time())
  }
  close(): void { this.db.close() }
  profile(runId: string): ResearchProfile {
    const row = this.db.prepare('SELECT body FROM research_profiles WHERE run_id=?').get(runId) as { body: string } | undefined
    return row ? parse<ResearchProfile>(row.body) : { runId, enabled: false, goal: '', organism: '', strain: '', metric: '', conditions: '', customFields: [] }
  }
  saveProfile(value: ResearchProfile): ResearchProfile {
    this.db.prepare('INSERT INTO research_profiles(run_id,body,updated_at) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at').run(value.runId, JSON.stringify(value), time())
    return value
  }
  createJob(runId: string, query: string, providers: ResearchProvider[], limit = 10): ResearchJob {
    const now = time(); const job: ResearchJob = { id: id('research-job'), runId, query, providers, status: 'QUEUED', found: 0, errors: [], createdAt: now, updatedAt: now }
    this.db.prepare('INSERT INTO research_jobs(id,run_id,query,providers,status,found,errors,created_at,updated_at,search_limit) VALUES(?,?,?,?,?,?,?,?,?,?)').run(job.id, runId, query, JSON.stringify(providers), job.status, job.found, JSON.stringify([]), now, now, limit)
    return job
  }
  job(runId: string, jobId: string): ResearchJob {
    const row = this.db.prepare('SELECT * FROM research_jobs WHERE run_id=? AND id=?').get(runId, jobId) as Record<string, unknown> | undefined
    if (!row) throw new Error('研究任务不存在。')
    return this.jobRow(row)
  }
  jobs(runId: string): ResearchJob[] {
    return (this.db.prepare('SELECT * FROM research_jobs WHERE run_id=? ORDER BY created_at DESC LIMIT 100').all(runId) as Array<Record<string, unknown>>).map(row => this.jobRow(row))
  }
  jobLimit(runId: string, jobId: string): number { const row=this.db.prepare('SELECT search_limit FROM research_jobs WHERE run_id=? AND id=?').get(runId,jobId) as {search_limit:number}|undefined; if(!row)throw new Error('研究任务不存在。'); return row.search_limit }
  updateJob(runId: string, jobId: string, patch: Partial<Pick<ResearchJob, 'status'|'found'|'errors'>>): ResearchJob {
    const old = this.job(runId, jobId); const next = { ...old, ...patch, updatedAt: time() }
    this.db.prepare('UPDATE research_jobs SET status=?,found=?,errors=?,updated_at=? WHERE run_id=? AND id=?').run(next.status,next.found,JSON.stringify(next.errors),next.updatedAt,runId,jobId)
    return next
  }
  upsertSource(runId: string, input: Omit<ResearchSource,'id'|'runId'>): ResearchSource {
    const existing = this.db.prepare('SELECT id,body FROM research_sources WHERE run_id=? AND provider=? AND external_id=?').get(runId,input.provider,input.externalId) as {id:string;body:string}|undefined
    const byDoi = input.doi ? this.db.prepare('SELECT id,body FROM research_sources WHERE run_id=? AND doi=?').get(runId,input.doi) as {id:string;body:string}|undefined : undefined
    const row = existing ?? byDoi
    if (row) {
      const prior = parse<ResearchSource>(row.body)
      const rank = (level: ResearchSource['documentLevel']) => ({metadata:0,abstract:1,dataset:2,fulltext:3}[level])
      const richer = rank(input.documentLevel) >= rank(prior.documentLevel)
      const merged: ResearchSource = { ...prior, ...input, id: row.id, runId, provider: prior.provider, externalId: prior.externalId, ...(richer ? {} : {documentLevel:prior.documentLevel,text:prior.text}), ...(!richer && prior.fetchError ? {fetchError:prior.fetchError} : {}) }
      this.db.prepare('UPDATE research_sources SET body=?,doi=COALESCE(?,doi) WHERE id=?').run(JSON.stringify(merged), input.doi ?? null, row.id)
      return merged
    }
    const sourceCount=this.db.prepare('SELECT COUNT(*) AS count FROM research_sources WHERE run_id=?').get(runId) as {count:number}
    if(sourceCount.count>=500) throw new Error('At most 500 research sources are allowed per workflow run')
    const source: ResearchSource = { ...input, id:id('source'),runId }
    this.db.prepare('INSERT INTO research_sources(id,run_id,provider,external_id,doi,body,created_at) VALUES(?,?,?,?,?,?,?)').run(source.id,runId,source.provider,source.externalId,source.doi ?? null,JSON.stringify(source),time())
    return source
  }
  source(runId: string, sourceId: string): ResearchSource {
    const row = this.db.prepare('SELECT body FROM research_sources WHERE run_id=? AND id=?').get(runId,sourceId) as {body:string}|undefined
    if (!row) throw new Error('研究来源不存在。')
    return parse<ResearchSource>(row.body)
  }
  sources(runId: string): ResearchSource[] {
    return (this.db.prepare('SELECT body FROM research_sources WHERE run_id=? ORDER BY created_at DESC').all(runId) as Array<{body:string}>).map(row => parse<ResearchSource>(row.body))
  }
  updateSource(runId: string, source: ResearchSource): ResearchSource {
    const prior=this.source(runId,source.id);const rank=(level:ResearchSource['documentLevel'])=>({metadata:0,abstract:1,dataset:2,fulltext:3}[level])
    const updated:ResearchSource=rank(source.documentLevel)<rank(prior.documentLevel)?{...source,documentLevel:prior.documentLevel,text:prior.text,url:prior.url,...(prior.note?{note:prior.note}:{})}:source
    this.db.prepare('UPDATE research_sources SET body=?,doi=? WHERE id=? AND run_id=?').run(JSON.stringify(updated),updated.doi ?? null,updated.id,runId)
    return updated
  }
  addRecord(input: ResearchRecord): ResearchRecord {
    this.db.prepare('INSERT INTO research_records(id,run_id,source_id,body,created_at) VALUES(?,?,?,?,?)').run(input.id,input.runId,input.sourceId,JSON.stringify(input),input.createdAt)
    return input
  }
  record(runId: string, recordId: string): ResearchRecord {
    const row = this.db.prepare('SELECT body FROM research_records WHERE run_id=? AND id=?').get(runId,recordId) as {body:string}|undefined
    if (!row) throw new Error('研究记录不存在。')
    return this.withExports(runId,parse<ResearchRecord>(row.body))
  }
  linkExport(runId:string,recordId:string,datasetId:string,name:string):void { this.db.prepare('INSERT OR IGNORE INTO research_exports(run_id,record_id,dataset_id,name,created_at) VALUES(?,?,?,?,?)').run(runId,recordId,datasetId,name,time()) }
  exports(runId:string,recordId:string):Array<{datasetId:string;name:string}> { return (this.db.prepare('SELECT dataset_id,name FROM research_exports WHERE run_id=? AND record_id=? ORDER BY created_at').all(runId,recordId) as Array<{dataset_id:string;name:string}>).map(row=>({datasetId:row.dataset_id,name:row.name})) }
  records(runId: string): ResearchRecord[] {
    return (this.db.prepare('SELECT body FROM research_records WHERE run_id=? ORDER BY created_at DESC').all(runId) as Array<{body:string}>).map(row => this.withExports(runId,parse<ResearchRecord>(row.body)))
  }
  private withExports(runId:string,record:ResearchRecord):ResearchRecord { const exportedDatasetIds=this.exports(runId,record.id).map(item=>item.datasetId); return exportedDatasetIds.length?{...record,exportedDatasetIds}:record }
  private jobRow(row: Record<string, unknown>): ResearchJob {
    return { id:String(row.id),runId:String(row.run_id),query:String(row.query),providers:parse<ResearchProvider[]>(row.providers),status:String(row.status) as ResearchJobStatus,found:Number(row.found),errors:parse<string[]>(row.errors),createdAt:String(row.created_at),updatedAt:String(row.updated_at) }
  }
}
