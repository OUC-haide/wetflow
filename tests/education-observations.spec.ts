import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createEducationService, type EducationCard } from '../src/plugins/education.js'
import { educationBriefObservation, educationSearchObservation } from '../src/plugins/education-agent-view.js'
import { educationResources } from '../src/plugins/education-resources.js'

const data = JSON.parse(readFileSync(new URL('../examples/education/education-library.json', import.meta.url), 'utf8'))
const cards = data.cards as EducationCard[]
const service = createEducationService(cards, () => cards.map(card => card.document),
  name => [`[证据: ${name}#1]`], { categories: data.categories })
const base = { audience: 'primary', durationMinutes: 20, learningGoal: 'Explain how bases pair in DNA',
  resources: ['纸', '彩笔', '黏土'], caseIds: ['buct-tactile'] }

describe('Education resource matching', () => {
  it.each([
    ['纸', '彩笔', '黏土'], ['白纸', '水彩笔', '粘土'],
    ['Paper', 'Coloured pens', 'Modelling clay'], ['纸（A4白纸）', '彩笔和黏土'],
  ])('recognizes confirmed Chinese and English materials: %j', (...resources) => {
    const brief = service.brief({ ...base, resources })
    expect(brief.comparisons[0]?.resourcesToConfirm).toEqual([])
    expect(brief.availableResources).toEqual(resources)
  })
  it('does not confuse pencils, paper or internet with distinct requirements', () => {
    const resources = educationResources(['纸', '铅笔', '电脑', '网络'])
    expect(resources.missing(['paper', 'colored pens', 'printed game cards', 'laptop', 'internet', 'projector']))
      .toEqual(['colored pens', 'printed game cards', 'laptop', 'projector'])
    expect(educationResources(['笔记本电脑']).missing(['computer', 'laptop'])).toEqual([])
  })
  it('preserves missing materials after a follow-up removes clay', () => {
    expect(service.brief({ ...base, resources: ['纸', '彩笔'] }).comparisons[0]?.resourcesToConfirm).toEqual(['clay'])
  })
  it('keeps optional and unavailable resources out of confirmed materials', () => {
    const brief = service.brief({ ...base, resources: ['纸', '彩笔', '黏土（待确认）', '没有投影仪', 'computer if available'],
      optionalResources: ['黑板或大白纸'] })
    expect(brief.availableResources).toEqual(['纸', '彩笔'])
    expect(brief.optionalResources).toEqual(['黑板或大白纸', '黏土（待确认）', 'computer if available'])
    expect(brief.unavailableResources).toEqual(['没有投影仪'])
    expect(brief.comparisons[0]?.resourcesToConfirm).toEqual(['clay'])
  })
  it('matches unknown material names only when explicitly supplied', () => {
    expect(educationResources(['custom teaching kit']).missing(['custom teaching kit', 'teaching kit'])).toEqual(['teaching kit'])
  })
})

describe('Education complete-case observations', () => {
  it('pages full source records without dropping, duplicating or truncating cases', () => {
    const longerCards = cards.map(card => ({ ...card, practice: card.practice.repeat(3) }))
    const pagedService = createEducationService(longerCards, () => cards.map(card => card.document),
      name => [`[证据: ${name}#1]`], { categories: data.categories })
    const expected = pagedService.search({ query: '2025', collection: 'historical', limit: 8 }).items
    const seen: ReturnType<typeof educationSearchObservation>['items'] = []
    let offset = 0, pages = 0
    do {
      const result = educationSearchObservation(pagedService.search({ query: '2025', collection: 'historical', limit: 8, offset }))
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(5700)
      expect(result.offset).toBe(offset)
      expect(result.returned).toBeGreaterThan(0)
      seen.push(...result.items)
      pages++
      if (result.nextOffset === null) break
      expect(result.nextOffset).toBe(offset + result.items.length)
      offset = result.nextOffset
      expect(pages).toBeLessThan(10)
    } while (true)
    expect(pages).toBeGreaterThan(1)
    expect(seen.map(item => item.id)).toEqual(expected.map(item => item.id))
    for (const item of seen) {
      const original = expected.find(card => card.id === item.id)!
      expect(item.reportedPractice).toBe(original.practice)
      expect(item.reportedReflection).toBe(original.reflection)
      expect(item.citations).toEqual(original.citations)
      expect(item).not.toHaveProperty('adaptation')
      expect(item).not.toHaveProperty('proposedAdaptation')
    }
  })
  it('preserves the six-category catalogue and empty result behavior', () => {
    const browse = educationSearchObservation(service.search({}))
    expect(browse.categories).toHaveLength(6)
    expect(JSON.stringify(browse).length).toBeLessThanOrEqual(5700)
    expect(browse.items).toEqual([])
    const missing = educationSearchObservation(service.search({ team: 'Unknown Team' }))
    expect(missing.total).toBe(0)
    expect(missing.nextOffset).toBeNull()
  })
  it('keeps every selected case and its explicitly owned proposal across brief pages', () => {
    const caseIds = ['buct-tactile', 'nnu-rainbow-orchard', 'nacis-cell-game', 'depu-dna-workshop', 'barcelona-dna-toolkit', 'heidelberg-platform']
    const view = service.brief({ ...base, caseIds })
    const seen: string[] = [], proposals: string[] = []
    let offset = 0, pages = 0
    do {
      const result = educationBriefObservation(view, offset)
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(5700)
      expect(result.weaveCycle).toHaveLength(5)
      expect(result.durationMinutes).toBe(20)
      for (const record of result.comparisons) {
        const original = view.comparisons.find(item => item.id === record.id)!
        expect(record.source).toEqual(original.source)
        expect(record.reportedPractice).toBe(original.reportedPractice)
        expect(record).not.toHaveProperty('proposedAdaptation')
        seen.push(record.id)
      }
      for (const proposal of result.wetflowProposals) {
        expect(proposal.authoredBy).toBe('WetFlow')
        expect(proposal.status).toBe('proposed')
        expect(proposal.sourceTeamImplementation).toBe('unknown')
        expect(proposal).not.toHaveProperty('citations')
        expect(proposal.suggestion).toBe(cards.find(card => card.id === proposal.caseId)?.adaptation)
        proposals.push(proposal.caseId)
      }
      pages++
      if (result.nextOffset === null) break
      expect(result.nextOffset).toBe(offset + result.comparisons.length)
      offset = result.nextOffset
      expect(pages).toBeLessThan(10)
    } while (true)
    expect(pages).toBeGreaterThan(1)
    expect(seen).toEqual(caseIds)
    expect(proposals).toEqual(caseIds)
  })
  it('does not silently truncate one oversized record or planning input', () => {
    const item = { ...cards.find(card => card.id === 'buct-tactile')!, practice: 'Source text '.repeat(800) }
    const large = createEducationService([item], () => [item.document])
    expect(() => educationSearchObservation(large.search({ team: 'BUCT' }))).toThrow('未返回截断案例')
    expect(() => educationBriefObservation(large.brief(base))).toThrow('未返回截断案例')
    expect(() => educationBriefObservation(service.brief(base), 1)).toThrow('分页超出')
    expect(() => service.search({ offset: -1 })).toThrow()
  })
})
