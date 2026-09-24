import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WetFlowStore } from '../src/core/store.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('conversation message order', () => {
  it('keeps insertion order when the system clock moves backwards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-store-clock-')); dirs.push(dir)
    const path = join(dir, 'wetflow.db')
    const store = new WetFlowStore(path)
    try {
      const conversationId = store.activeConversationId()
      const raw = new DatabaseSync(path)
      const insert = raw.prepare(`INSERT INTO messages (id, role, content, approval_id, created_at, conversation_id)
        VALUES (?, ?, ?, NULL, ?, ?)`)
      insert.run('clock-before', 'user', 'before clock adjustment', '2026-09-24T12:00:00.000Z', conversationId)
      insert.run('clock-after', 'assistant', 'after clock adjustment', '2026-09-24T11:00:00.000Z', conversationId)
      raw.close()

      expect(store.messages().filter(message => message.id.startsWith('clock-')).map(message => message.id))
        .toEqual(['clock-before', 'clock-after'])
    } finally { store.close() }
  })
})
