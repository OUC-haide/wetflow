// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { MessageContent } from '../src/web/MessageContent.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('stored scientific answers', () => {
  it('renders a real Markdown table without losing values, units or source citations', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    const answer = '## 模体比较\n\n| 模体 | 末段 RMSD |\n| --- | --- |\n| S1 | 2.53 Å |\n| S2 | 1.83 Å |\n\n[证据: analysis-v2-derived-tables.json#3]\n\n1. **独立重复**。'
    try {
      await act(async () => root.render(<MessageContent content={answer} />))
      expect(host.querySelector('h2')?.textContent).toBe('模体比较')
      expect([...host.querySelectorAll('tbody td')].map(td => td.textContent)).toEqual(['S1', '2.53 Å', 'S2', '1.83 Å'])
      expect(host.textContent).toContain('[证据: analysis-v2-derived-tables.json#3]')
      expect(host.querySelector('ol strong')?.textContent).toBe('独立重复')
    } finally { await act(async () => root.unmount()) }
  })

  it('does not execute raw HTML or model-supplied javascript links', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    try {
      await act(async () => root.render(<MessageContent content={'<img src=x onerror="alert(1)">\n\n[bad](javascript:alert%281%29)\n\n[source](https://europepmc.org/article/MED/41809402)'} />))
      expect(host.querySelector('img')).toBeNull()
      const links = [...host.querySelectorAll('a')]
      expect(links[0]?.getAttribute('href')).not.toMatch(/^javascript:/)
      expect(links[1]?.getAttribute('href')).toBe('https://europepmc.org/article/MED/41809402')
      expect(links[1]?.getAttribute('rel')).toBe('noreferrer')
    } finally { await act(async () => root.unmount()) }
  })
})
