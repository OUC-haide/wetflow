import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createEducationService, type EducationCard } from '../src/plugins/education.js'

const cards = JSON.parse(readFileSync(new URL('../examples/education/education-library.json', import.meta.url), 'utf8')).cards as EducationCard[]
const documents = [...new Set(cards.map(item => item.document))]
const all = () => createEducationService(cards, () => documents)
const input = { audience: 'secondary', durationMinutes: 60, learningGoal: 'Explain a waste-to-product manufacturing route', resources: ['paper'], caseIds: ['ouc-route-puzzle', 'heidelberg-platform'] }
describe('Education extension', () => {
  it('only returns cases backed by evidence in the active run', () => {
    const result = createEducationService(cards, () => ['HEIDELBERG-2025-EDUCATION.md']).search({ query: 'classroom learning', audience: 'secondary' })
    expect(result.items.map(item => item.id)).toEqual(['heidelberg-platform'])
    expect(createEducationService(cards, () => []).search({ query: 'learning' }).items).toEqual([])
  })
  it('filters audience-specific activities', () => {
    expect(all().search({ query: 'tactile clay', audience: 'university' }).items).toEqual([])
    expect(all().search({ query: 'tactile clay', audience: 'primary' }).items.some(item => item.id === 'buct-tactile')).toBe(true)
  })
  it('returns the real evidence markers supplied by the existing evidence service', () => {
    const service = createEducationService(cards, () => documents, name => [`[证据: ${name}#2]`])
    const result = service.search({ query: 'interactive learning', audience: 'secondary' })
    expect(result.items.every(item => item.citations[0] === `[证据: ${item.document}#2]`)).toBe(true)
    expect(service.brief(input).comparisons[1]?.source.citations).toEqual(['[证据: HEIDELBERG-2025-EDUCATION.md#2]'])
  })
  it('keeps classroom duration separate from the full WEAVE cycle and retains attribution', () => {
    const result = all().brief(input)
    expect(result.durationMinutes).toBe(60)
    expect(result).not.toHaveProperty('agenda')
    expect(result.weaveCycle.map(stage => stage.phase)).toEqual(['Wonder', 'Explore', 'Action', 'Verify', 'Echo'])
    expect(result.weaveCycle.every(stage => !('minutes' in stage))).toBe(true)
    expect(result.weaveCycle[0]?.purpose).toContain('learning needs')
    expect(result.weaveCycle[1]?.purpose).toContain('learning objectives')
    expect(result.comparisons[1]?.resourcesToConfirm).toEqual(['laptop', 'projector'])
    expect(result.comparisons[1]?.source.url).toBe('https://2025.igem.wiki/heidelberg/education')
    expect(result.comparisons[0]?.reportedPractice).not.toEqual(result.comparisons[0]?.proposedAdaptation)
  })
  it('does not turn a proposed classroom design into completed evaluation or improvement', () => {
    const result = all().brief({ ...input, audience: 'primary', durationMinutes: 30, caseIds: ['ouc-dna-builder', 'buct-tactile'] })
    expect(result.weaveCycle[2]?.status).toBe('proposed_not_delivered')
    expect(result.weaveCycle[3]?.status).toBe('awaiting_classroom_evidence')
    expect(result.weaveCycle[4]?.status).toBe('awaiting_feedback_and_iteration')
    expect(result.weaveCycle[4]?.purpose).toContain('later iterations')
  })
  it('retains supplied audience needs but leaves absent feedback explicitly unknown', () => {
    const result = all().brief({ ...input, audienceNeeds: 'A concrete introduction to DNA; prior knowledge needs teacher confirmation.' })
    expect(result.audienceNeeds).toContain('teacher confirmation')
    expect(result.previousFeedback).toBeNull()
    expect(result.informationToConfirm).toEqual(['No previous-activity feedback was supplied; do not invent it.'])
    const withFeedback = all().brief({ ...input, audienceNeeds: 'Supplied needs', previousFeedback: 'A prior session required clearer diagrams.' })
    expect(withFeedback.previousFeedback).toContain('clearer diagrams')
    expect(withFeedback.informationToConfirm).toEqual([])
  })
  it('refuses a case whose evidence is outside the active run', () => {
    const limited = createEducationService(cards, () => ['OUC-EDU-WEAVE.md'])
    expect(() => limited.brief(input)).toThrow('not available in the current run')
  })
  it('rejects missing goals, invalid timing and repeated cases', () => {
    expect(() => all().brief({ ...input, learningGoal: '' })).toThrow()
    expect(() => all().brief({ ...input, durationMinutes: 0 })).toThrow()
    expect(() => all().brief({ ...input, caseIds: ['ouc-route-puzzle', 'ouc-route-puzzle'] })).toThrow('distinct')
  })
})
