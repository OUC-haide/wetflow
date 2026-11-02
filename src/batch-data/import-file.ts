import type { Cell } from 'exceljs'
import { MAX_IMPORT_FILE_BYTES } from './import-types.js'
import type { ImportDocument, ImportTable, ImportTableRow } from './import-types.js'

const MAX_ROWS = 2001, MAX_COLUMNS = 80, MAX_CELLS = 160_080

function decimalText(value: number): string {
  // Excel numbers have already been rounded by Excel; never round them again for import.
  const text = String(value)
  if (!/[eE]/.test(text)) return text
  const [coefficient, exponent] = text.toLowerCase().split('e')
  const negative = coefficient!.startsWith('-')
  const [whole, fraction = ''] = coefficient!.replace('-', '').split('.')
  const digits = whole! + fraction, point = whole!.length + Number(exponent)
  return (negative ? '-' : '') + (point <= 0 ? '0.' + '0'.repeat(-point) + digits
    : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point))
}

function cellText(cell: Cell, warnings: Set<string>): string {
  // Do not copy merged parent values into empty measurement cells.
  if (cell.isMerged && cell.master.address !== cell.address) return ''
  const value = cell.value
  if (value == null) return ''
  if (cell.type === 6) {
    warnings.add('公式单元格只读取 Excel 已保存的计算结果，不重新计算；请核对后导入。')
    if (cell.result === undefined || cell.result === null) return '#公式无缓存结果'
    if (typeof cell.result === 'number') return decimalText(cell.result)
    return typeof cell.result === 'string' ? cell.result : '#公式结果不可用'
  }
  if (value instanceof Date) {
    warnings.add('Excel 日期不包含时区；采样时间列请在生成后的预览中补充实际时区。')
    return value.toISOString().replace(/Z$/, '')
  }
  if (typeof value === 'number') {
    // A simple fixed-decimal format can retain displayed trailing zeros without losing digits.
    const match = /^0\.(0{1,12})$/.exec(cell.numFmt)
    const raw = decimalText(value)
    if (match && !raw.includes('e') && (raw.split('.')[1]?.length ?? 0) <= match[1]!.length) {
      return raw.includes('.') ? raw.padEnd(raw.indexOf('.') + 1 + match[1]!.length, '0') : raw + '.' + match[1]
    }
    return raw
  }
  return cell.text
}

async function readWorkbook(name: string, bytes: Buffer): Promise<ImportDocument> {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0])
  const warnings = new Set<string>(), tables: ImportTable[] = []
  let cells = 0
  for (const sheet of workbook.worksheets) {
    if (sheet.state !== 'visible') { warnings.add(`已跳过隐藏工作表：${sheet.name}`); continue }
    const rows: ImportTableRow[] = []
    sheet.eachRow(row => {
      if (row.cellCount > MAX_COLUMNS) throw new Error(`工作表「${sheet.name}」超过 ${MAX_COLUMNS} 列，请先拆分。`)
      const values = Array.from({ length: row.cellCount }, (_, i) => cellText(row.getCell(i + 1), warnings))
      if (!values.some(x => x.trim())) return
      if (row.hidden) warnings.add(`工作表「${sheet.name}」包含隐藏行，已纳入预览，请核对选择范围。`)
      rows.push({ cells: values, locator: `${sheet.name}!A${row.number}:${sheet.getColumn(Math.max(1, row.cellCount)).letter}${row.number}` })
      cells += values.length
      if (rows.length > MAX_ROWS || cells > MAX_CELLS) throw new Error('表格过大，请将文件拆分为每张表不超过 2000 条数据后导入。')
    })
    if (rows.length) tables.push({ id: String(sheet.id), label: sheet.name, rows })
    if (tables.length > 30) throw new Error('一次最多读取 30 个工作表，请先拆分文件。')
  }
  if (!tables.length) throw new Error('Excel 中没有可读取的可见数据表。')
  return { name, format: 'xlsx', tables, warnings: [...warnings] }
}

interface PositionedText { text: string; x: number; y: number; width: number; height: number }
/** Reconstruct columns by position so a missing middle cell never shifts later values left. */
export function pdfTableRows(items: PositionedText[], page: number): ImportTableRow[] {
  const lines: Array<{ y: number; items: PositionedText[] }> = []
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (!item.text.trim()) continue
    const line = lines.findLast(row => Math.abs(row.y - item.y) <= 2)
    if (line) line.items.push(item)
    else lines.push({ y: item.y, items: [item] })
  }
  const rows = lines.map(line => {
    const cells: PositionedText[] = []
    for (const item of line.items.sort((a, b) => a.x - b.x)) {
      const previous = cells.at(-1)
      const gap = previous ? item.x - previous.x - previous.width : Infinity
      if (previous && gap < Math.max(4, item.height * 0.6)) {
        previous.text += (gap > 1 ? ' ' : '') + item.text
        previous.width = item.x + item.width - previous.x
      } else cells.push({ ...item })
    }
    return cells
  })
  // The most complete row establishes the columns; right-aligned numbers may start later
  // than their headers, so assigning by nearest text start would create false columns.
  const reference = rows.reduce<PositionedText[]>((best, row) => row.length > best.length ? row : best, [])
  const anchors = reference.map(cell => cell.x)
  if (anchors.length < 2) return []
  if (anchors.length > MAX_COLUMNS || rows.length > MAX_ROWS) throw new Error(`PDF 第 ${page} 页的表格过于复杂，请拆分表格后导入。`)
  return rows.map((row, i) => {
    const cells = Array<string>(anchors.length).fill('')
    for (const cell of row) {
      let index = 0
      for (let j = 1; j < anchors.length; j++) if (cell.x >= anchors[j]! - 8) index = j
      cells[index] = cells[index] ? cells[index] + ' ' + cell.text : cell.text
    }
    return { cells, locator: `第 ${page} 页，第 ${i + 1} 文本行` }
  })
}

async function readPdf(name: string, bytes: Buffer): Promise<ImportDocument> {
  const { getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { useSystemFonts: true })
  try {
    if (pdf.numPages > 50) throw new Error('一次最多读取 50 页 PDF，请先选取需要的表格页。')
    const tables: ImportTable[] = [], warnings = ['PDF 按文字位置还原表格，请核对列、空值和跨行内容后再导入。']
    let cells = 0
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), content = await page.getTextContent(), viewport = page.getViewport({ scale: 1 })
      const items: PositionedText[] = []
      for (const item of content.items) if ('str' in item) {
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
        items.push({ text: item.str, x: x!, y: y!, width: item.width, height: item.height })
      }
      const rows = pdfTableRows(items, i)
      if (rows.length) tables.push({ id: String(i), label: `第 ${i} 页`, rows })
      else warnings.push(`第 ${i} 页未识别出文字表格${items.some(x => x.text.trim()) ? '' : '，可能是扫描页或空白页'}。`)
      cells += rows.reduce((sum, row) => sum + row.cells.length, 0)
      if (cells > MAX_CELLS) throw new Error('PDF 表格数据过多，请拆分文件后导入。')
      page.cleanup()
    }
    if (!tables.length) throw new Error('未识别到可提取的文字表格。扫描版 PDF 请先进行 OCR 文字识别，或使用原始 Excel 文件。')
    return { name, format: 'pdf', tables, warnings }
  } finally { await pdf.loadingTask.destroy() }
}

export async function extractImportFile(name: string, dataUrl: string): Promise<ImportDocument> {
  const cleanName = name.split(/[\\/]/).at(-1)!.trim()
  if (!cleanName || cleanName.length > 200) throw new Error('文件名无效或超过 200 个字符。')
  const extension = cleanName.split('.').at(-1)?.toLowerCase()
  if (extension !== 'xlsx' && extension !== 'pdf') throw new Error('请选择 .xlsx 或 .pdf 文件；CSV 可直接导入。')
  const match = /^data:[^;,]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)
  if (!match || match[1]!.length > Math.ceil(MAX_IMPORT_FILE_BYTES / 3) * 4) throw new Error('文件内容无效或超过 10 MiB。')
  const bytes = Buffer.from(match[1]!, 'base64')
  if (!bytes.length || bytes.length > MAX_IMPORT_FILE_BYTES) throw new Error('文件为空或超过 10 MiB。')
  if (extension === 'pdf' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('文件内容不是有效的 PDF。')
  if (extension === 'xlsx' && bytes.toString('ascii', 0, 2) !== 'PK') throw new Error('文件内容不是有效的 .xlsx 工作簿。')
  return extension === 'xlsx' ? readWorkbook(cleanName, bytes) : readPdf(cleanName, bytes)
}
