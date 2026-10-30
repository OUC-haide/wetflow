import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readLocalFile, resolveLocalPath } from '../src/plugins/local-file.js'
import { isVisualToolResult } from '../src/agent/media.js'
import { pdfFixture } from './fixtures/pdf.js'

const dirs: string[] = []
function file(name: string, data: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'wetflow-file-'))
  dirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, data)
  return path
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
async function readText(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await readLocalFile(input)
  if (isVisualToolResult(result)) throw new Error('Expected a text-only observation')
  return result
}

describe('local file reading', () => {
  it('preserves Chinese, quoted text and long lines across bounded excerpts', async () => {
    const source = '第一行\n' + '"\\\t水下粘合剂😀'.repeat(1200) + '\n最后一行'
    const path = file('实验记录.md', source)
    let offset = 0, reconstructed = '', calls = 0
    while (true) {
      const result = await readText({ path: `"${path}"`, offset })
      expect(isVisualToolResult(result)).toBe(false)
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(5500)
      expect(result.citation).toContain('实验记录.md#L')
      reconstructed += result.text
      calls++
      if (!result.next) break
      offset = (result.next as { offset: number }).offset
      expect(calls).toBeLessThan(100)
    }
    expect(reconstructed).toBe(source)
    expect(calls).toBeGreaterThan(1)
  })

  it('decodes UTF-16 BOM and maps Windows and file URL paths for WSL', async () => {
    const path = file('中文.txt', Buffer.concat([Buffer.from([255, 254]), Buffer.from('温度 30 °C', 'utf16le')]))
    expect((await readText({ path })).text).toBe('温度 30 °C')
    if (process.platform !== 'win32') {
      expect(resolveLocalPath('"C:\\Users\\实验\\记录.txt"')).toBe('/mnt/c/Users/实验/记录.txt')
      expect(resolveLocalPath('file:///C:/Users/%E5%AE%9E%E9%AA%8C/a.pdf')).toBe('/mnt/c/Users/实验/a.pdf')
    }
    expect(() => resolveLocalPath('https://example.org/a.txt')).toThrow('网络')
  })

  it('rejects invalid offsets, binary data and directories', async () => {
    const path = file('binary.bin', Buffer.from([0, 1, 2, 3]))
    await expect(readLocalFile({ path })).rejects.toThrow('二进制')
    await expect(readLocalFile({ path: dirs[0]! })).rejects.toThrow('普通文件')
    await expect(readLocalFile({ path: file('empty.txt', ''), offset: 10 })).rejects.toThrow('offset')
  })

  it('reads actual PDF pages with stable page citations and next-page cursor', async () => {
    const path = file('report.pdf', pdfFixture(['Page one feed 1.00', 'Page two feed 1.25']))
    const first = await readText({ path, mode: 'text' })
    expect(first.text).toContain('Page one feed 1.00')
    expect(first.text).not.toContain('Page two')
    expect(first.citation).toBe('[文件: report.pdf#p1]')
    expect(first.next).toEqual({ page: 2, offset: 0 })
    const second = await readText({ path, page: 2, mode: 'text' })
    expect(second.text).toContain('Page two feed 1.25')
    expect(second.next).toBeNull()
    await expect(readLocalFile({ path, page: 3 })).rejects.toThrow('2 页')
  })

  it('renders a PDF chart/text page and pages without a text layer into decodable images', async () => {
    const path = file('visual.pdf', pdfFixture(['Visible text', '']))
    for (const input of [{ path, mode: 'image' }, { path, page: 2 }]) {
      const result = await readLocalFile(input)
      expect(isVisualToolResult(result)).toBe(true)
      if (!isVisualToolResult(result)) throw new Error('Missing visual result')
      const image = await loadImage(Buffer.from(result.images[0]!.dataUrl.split(',')[1]!, 'base64'))
      expect(image.width).toBeGreaterThan(100)
      expect(image.height).toBeGreaterThan(100)
      expect(JSON.stringify(result.observation).length).toBeLessThan(5500)
    }
    const text = await readText({ path, page: 2, mode: 'text' })
    expect(text.text).toBe('')
    expect(text.note).toContain('扫描件')
  })

  it('sends image bytes separately from the textual observation and resizes large images', async () => {
    const canvas = createCanvas(2400, 1200)
    canvas.getContext('2d').fillRect(0, 0, 200, 200)
    const path = file('figure.png', await canvas.encode('png'))
    const result = await readLocalFile({ path })
    if (!isVisualToolResult(result)) throw new Error('Missing visual result')
    expect(JSON.stringify(result.observation)).not.toContain('base64')
    const image = await loadImage(Buffer.from(result.images[0]!.dataUrl.split(',')[1]!, 'base64'))
    expect(image.width).toBe(1800)
    await expect(readLocalFile({ path, mode: 'text' })).rejects.toThrow('视觉')
  })
})
