import type { ResearchProvider } from './providers.js'

export interface ResearchProfile {
  runId: string
  enabled: boolean
  goal: string
  organism: string
  strain: string
  metric: string
  conditions: string
  customFields: string[]
}

export type ResearchJobStatus = 'QUEUED' | 'SEARCHING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'
export interface ResearchJob {
  id: string
  runId: string
  query: string
  providers: ResearchProvider[]
  status: ResearchJobStatus
  found: number
  errors: string[]
  createdAt: string
  updatedAt: string
}

export interface ResearchSource {
  id: string
  runId: string
  provider: ResearchProvider
  externalId: string
  title: string
  url: string
  doi?: string
  authors?: string
  year?: string
  abstract?: string
  pmcid?: string
  accession?: string
  documentLevel: 'metadata' | 'abstract' | 'fulltext' | 'dataset'
  note?: string
  text: string
  fetchError?: string
}

export interface ResearchPoint { time: number; value: number }
export interface ResearchRecordInput {
  runId: string
  sourceId: string
  organism: string
  strain: string
  medium: string
  temperatureC?: number
  pH?: number
  metric: string
  unit: string
  points: ResearchPoint[]
  timeUnit: 'h' | 'min' | 's'
  evidenceQuote: string
  locator: string
  custom?: Record<string, string>
}
export interface ResearchRecord extends ResearchRecordInput {
  id: string
  createdAt: string
  origin: 'literature'
  status: 'EXTRACTED'
  exportedDatasetIds?: string[]
}

export interface ResearchSqlTable { name: string; columns: string[]; description: string }
export interface ResearchSqlResult { columns: string[]; rows: Array<Record<string, unknown>>; truncated: boolean }
