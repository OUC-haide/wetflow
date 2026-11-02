import type { createEducationService } from './education.js'

type Service = ReturnType<typeof createEducationService>
const MAX_VIEW_CHARS = 5700
const fits = (value: unknown) => JSON.stringify(value).length <= MAX_VIEW_CHARS
const attribution = 'Cite only reportedPractice/reportedReflection and source status. Unreported details do not establish that a team did not use a method or assessment. WetFlow proposals are new suggestions, never source-team practices or recommendations; state them separately without appending source-team citations.'

function page<T, R>(items: T[], offset: number, total: number, render: (items: T[], nextOffset: number | null) => R) {
  const selected = [...items]
  const result = () => render(selected, offset + selected.length < total ? offset + selected.length : null)
  // Remove entire cases, including their proposals, rather than cutting JSON
  // or silently losing the conditions and source attribution on the last case.
  while (selected.length > 1 && !fits(result())) selected.pop()
  if (!fits(result())) throw new Error('教育案例或规划输入过长，无法完整返回。请缩短规划输入，或按团队检索并用 evidence_search 读取原文；未返回截断案例。')
  return result()
}

export function educationSearchObservation(view: ReturnType<Service['search']>) {
  const items = view.items.map(item => ({ id: item.id, owner: item.owner, year: item.year,
    title: item.title, audiences: item.audiences, category: item.category, collection: item.collection,
    status: item.status, document: item.document, url: item.url, location: item.location,
    citations: item.citations, reportedPractice: item.practice, reportedReflection: item.reflection,
    requiredResources: item.requiredResources }))
  return page(items, view.offset, view.total, (items, nextOffset) => ({
    framework: view.framework, scope: view.scope, historicalCaseCount: view.historicalCaseCount,
    ...(view.browseOnly ? { categories: view.categories } : {}),
    items, total: view.total, offset: view.offset, returned: items.length, nextOffset,
    continuation: nextOffset === null ? null : 'Call education_search_cases with the same filters and nextOffset as offset to read more complete cases.',
    attribution,
  }))
}

export function educationBriefObservation(view: ReturnType<Service['brief']>, offset = 0) {
  const total = view.comparisons.length
  if (offset > 0 && offset >= total) throw new Error('教育简报分页超出所选案例范围，请从 offset=0 开始。')
  return page(view.comparisons.slice(offset), offset, total, (items, nextOffset) => ({
    audience: view.audience, learningGoal: view.learningGoal, durationMinutes: view.durationMinutes,
    audienceNeeds: view.audienceNeeds, previousFeedback: view.previousFeedback,
    availableResources: view.availableResources, optionalResources: view.optionalResources,
    unavailableResources: view.unavailableResources, informationToConfirm: view.informationToConfirm,
    resourceRule: 'The core activity must work with availableResources alone. If a step mentions optional equipment, give an immediate alternative using confirmed materials in that same step. Do not require a blackboard, large paper, printer, glue, scissors or camera unless confirmed.',
    weaveCycle: view.weaveCycle.map(({ phase, label, question, status }) => ({ phase, label, question, status })),
    frameworkSource: view.frameworkSource,
    comparisons: items.map(({ proposedAdaptation: _proposal, ...source }) => source),
    // No source citation on suggestions. The case ID links each proposal to its
    // inspiration without treating the proposal as evidence of what a team did.
    wetflowProposals: items.map(item => ({ caseId: item.id, authoredBy: 'WetFlow',
      status: 'proposed', sourceTeamImplementation: 'unknown',
      attributionNote: 'This is a WetFlow planning suggestion. The library does not establish whether the original team ever used this idea; do not claim that they did or did not.',
      suggestion: item.proposedAdaptation })),
    total, offset, returned: items.length, nextOffset,
    continuation: nextOffset === null ? null : 'Call education_make_brief again with the same inputs and nextOffset as offset before using the remaining selected cases.',
    attribution, planningNote: view.planningNote,
  }))
}
