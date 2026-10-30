import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { ChatAttachment } from './core/types.js'
import { detectFileKind, MAX_LOCAL_FILE_BYTES, modelImage } from './plugins/local-file.js'

export class AttachmentStore {
  constructor(private readonly directory: string) {}

  async save(runId: string, name: unknown, dataUrl: unknown): Promise<ChatAttachment> {
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || typeof dataUrl !== 'string') throw new Error('附件需要文件名和内容。')
    const match = /^data:[\w.+\-/]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)
    if (!match || match[1]!.length > Math.ceil(MAX_LOCAL_FILE_BYTES / 3) * 4) throw new Error('附件编码无效或超过 20 MiB。')
    const bytes = Buffer.from(match[1]!, 'base64')
    if (bytes.length > MAX_LOCAL_FILE_BYTES) throw new Error('附件超过 20 MiB。')
    const kind = detectFileKind(bytes)
    const id = randomUUID()
    const directory = resolve(this.directory, runId, id)
    const safeName = basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f]/g, '_')
    if (!safeName || safeName === '.' || safeName === '..' || safeName === '.metadata.json') throw new Error('文件名无效。')
    const path = join(directory, safeName)
    // Validate supported image bytes before saving; PDFs are parsed on demand.
    if (kind === 'image') await modelImage(bytes, safeName)
    if (kind === 'text' && bytes.includes(0) && !(bytes[0] === 255 && bytes[1] === 254) && !(bytes[0] === 254 && bytes[1] === 255)) {
      throw new Error('不支持该二进制格式；请选择文本、PDF、PNG、JPEG 或 WebP。')
    }
    await mkdir(directory, { recursive: true })
    await writeFile(path, bytes, { mode: 0o600 })
    const attachment: ChatAttachment = { id, name: safeName, path, kind }
    await writeFile(join(directory, '.metadata.json'), JSON.stringify(attachment), { mode: 0o600 })
    return attachment
  }

  async get(runId: string, id: string): Promise<ChatAttachment> {
    if (!/^[a-z0-9-]{36}$/.test(id)) throw new Error('附件标识无效。')
    try {
      const directory = resolve(this.directory, runId, id)
      const item = JSON.parse(await readFile(join(directory, '.metadata.json'), 'utf8')) as ChatAttachment
      return { ...item, path: join(directory, basename(item.name)) }
    } catch { throw new Error('附件不存在或不属于当前实验运行。') }
  }
}
