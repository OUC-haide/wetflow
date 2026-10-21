import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WetFlowStore } from '../src/core/store.js'

describe('saved model reasoning', () => {
  it('survives reopening without entering conversation context and is removed with an edited answer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wetflow-reasoning-display-'))
    const path = join(dir, 'workflow.db')
    let store = new WetFlowStore(path)
    try {
      const user = store.addMessage('user', 'A question')
      const response = store.addMessage('assistant', 'The final answer', undefined, 'Provider reasoning only')
      expect(store.messages().at(-1)).toEqual(response)
      expect(store.messagesForContext().at(-1)).not.toHaveProperty('reasoningContent')
      store.close()
      store = new WetFlowStore(path)
      expect(store.messages().at(-1)?.reasoningContent).toBe('Provider reasoning only')
      store.rewindMessage(user.id, 'Revised question')
      expect(store.messages().some(message => message.reasoningContent)).toBe(false)
      expect(store.addMessage('assistant', 'No reasoning available')).not.toHaveProperty('reasoningContent')
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
