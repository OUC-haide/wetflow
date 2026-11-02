/** Extracted cells stay as text until the existing database validator accepts them. */
export interface ImportTableRow { cells: string[]; locator: string }
export interface ImportTable { id: string; label: string; rows: ImportTableRow[] }
export interface ImportDocument {
  name: string
  format: 'xlsx' | 'pdf'
  tables: ImportTable[]
  warnings: string[]
}
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024
export interface ImportMapping {
  headerRow: number
  startRow: number
  endRow: number
  sample: number
  mode: 'long' | 'wide'
  value: number
  metric: number
  fixedMetric: string
  unit: number
  note: number
  sampledAt: number
  wideMetrics: Record<number, string>
}
