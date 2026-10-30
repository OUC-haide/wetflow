/** RFC-style quoted fields; values stay strings throughout import and export. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let closed = false
  const input = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') { quoted = false; closed = true }
      else cell += c
    } else if (c === '"') {
      if (cell || closed) throw new Error('CSV 引号位置错误。')
      quoted = true
    } else if (c === ',') { row.push(cell); cell = ''; closed = false }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++
      row.push(cell); if (row.some(value => value !== '')) rows.push(row)
      row = []; cell = ''; closed = false
    } else {
      if (closed) throw new Error('CSV 闭合引号后只能有分隔符或换行。')
      cell += c
    }
  }
  if (quoted) throw new Error('CSV 存在未闭合引号。')
  row.push(cell); if (row.some(value => value !== '')) rows.push(row)
  return rows
}
export function writeCsv(rows: string[][]): string {
  return '\uFEFF' + rows.map(row => row.map(value => {
    // Escape spreadsheet formulas while preserving numeric decimal strings.
    const safe = /^[=+@\t\r\n]/.test(value) || (/^-/.test(value) && !/^-?\d+(\.\d+)?$/.test(value)) ? "'" + value : value
    return '"' + safe.replaceAll('"', '""') + '"'
  }).join(',')).join('\r\n')
}
export const CSV_HEADERS = ['sample', 'metric', 'value', 'unit', 'source', 'locator', 'sampledAt', 'note']
