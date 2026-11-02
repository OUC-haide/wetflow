// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BatchDataWorkspace } from '../src/web/plugins/BatchDataWorkspace.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('shows approved organization reasons and before/after changes in the database panel', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const fetch = vi.fn(async (input: string) => ({ ok: true, json: async () => input.includes('management-history') ? [{
    id: 'audit1', at: '2026-11-02T00:00:00Z', actor: 'agent-approved', reason: '统一采样点命名',
    changes: [{ summary: '采样点：24小时 → 24 h', kind: 'record', id: 'record1', before: {}, after: {} }],
  }] : { rounds: [], batches: [], metrics: [], recordCount: 0 } }))
  vi.stubGlobal('fetch', fetch)
  try {
    await act(async () => root.render(<BatchDataWorkspace projectId="p" projectName="Test" onClose={() => {}}/>))
    const button = [...host.querySelectorAll('button')].find(x => x.textContent?.includes('整理记录'))!
    await act(async () => button.click())
    const dialog = host.querySelector('[role=dialog]')!
    expect(dialog.textContent).toContain('统一采样点命名')
    expect(dialog.textContent).toContain('24小时 → 24 h')
    expect(dialog.textContent).toContain('Agent 提议，用户批准')
    expect(fetch.mock.calls.every(x => !x[0].includes('/import'))).toBe(true)
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
})
