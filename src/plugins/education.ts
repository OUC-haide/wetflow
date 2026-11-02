import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { z } from 'zod'
import type { WetFlowContext } from './types.js'
import { educationSourcesDirectory } from './assets.js'
import { EDUCATION_WEAVE_POLICY, WEAVE_CYCLE } from './education-weave.js'
import { educationTeamContext } from './education-context.js'
import { educationResources } from './education-resources.js'
import { educationBriefObservation, educationSearchObservation } from './education-agent-view.js'

const audience = z.enum(['primary', 'secondary', 'university', 'mixed'])
const card = z.object({
  id: z.string(), owner: z.string(), year: z.number().int(), document: z.string(),
  url: z.string().min(1), location: z.string(), title: z.string(),
  audiences: z.array(audience), topics: z.array(z.string()), practice: z.string(),
  reflection: z.string(), adaptation: z.string(), requiredResources: z.array(z.string()),
  collection: z.enum(['historical', 'team', 'framework']).default('team'),
  category: z.string().optional(),
  status: z.enum(['reported_activity', 'published_resource', 'proposal', 'framework']).optional(),
  checkedOn: z.string().optional(), evidenceQuote: z.string().optional(),
})
const category = z.object({ id: z.string(), label: z.string(), description: z.string() })
const library = z.object({ categories: z.array(category).default([]), cards: z.array(card).min(1) })
export type EducationCard = z.infer<typeof card>
export type EducationCategory = z.infer<typeof category>
export const name = 'wetflow-education'
export const inject = ['wetflow', 'wetflowEvidence']
export interface Config { libraryPath: string; sourcesDirectory?: string }

const searchInput = z.object({ query: z.string().trim().max(500).default(''), category: z.string().optional(),
  team: z.string().trim().min(1).max(200).optional(),
  collection: z.enum(['historical', 'team', 'all']).default('all'), audience: audience.optional(),
  limit: z.number().int().min(1).max(8).default(5), offset: z.number().int().min(0).default(0) }).strict()
const briefInput = z.object({
  audience, durationMinutes: z.number().int().min(15).max(240),
  learningGoal: z.string().min(5).max(600),
  audienceNeeds: z.string().min(1).max(1200).optional(),
  previousFeedback: z.string().min(1).max(1200).optional(),
  resources: z.array(z.string().min(1).max(80)).max(20),
  optionalResources: z.array(z.string().min(1).max(80)).max(20).default([]),
  caseIds: z.array(z.string()).min(1).max(6),
  offset: z.number().int().min(0).default(0),
}).strict()

export function createEducationService(cards: EducationCard[], visibleDocuments: () => string[], sourceCitations: (document: string) => string[] = () => [],
  options: { categories?: EducationCategory[]; ensureSources?: () => void; bundledDocuments?: string[] } = {}) {
  const categories = options.categories ?? []
  const bundledDocuments = new Set(options.bundledDocuments ?? [])
  const catalogue = () => ({
    framework: 'WEAVE',
    historicalCaseCount: cards.filter(item => item.collection === 'historical').length,
    categories: categories.map(group => ({ ...group,
      cases: cards.filter(item => item.collection === 'historical' && item.category === group.id)
        .map(item => ({ id: item.id, title: item.title, owner: item.owner, year: item.year,
          audiences: item.audiences, status: item.status, url: item.url, location: item.location })),
    })),
  })
  const visible = () => {
    options.ensureSources?.()
    const documents = new Set(visibleDocuments())
    return cards.filter(item => documents.has(item.document))
  }
  return {
    catalogue,
    context(tokenBudget: number) {
      const documents = new Set(visibleDocuments())
      return educationTeamContext(cards.filter(item => bundledDocuments.has(item.document) || documents.has(item.document)), categories, tokenBudget)
    },
    search(raw: unknown) {
      const input = searchInput.parse(raw)
      if (input.category && !categories.some(item => item.id === input.category)) throw new Error(`Unknown education category: ${input.category}`)
      const terms = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(input.query.toLowerCase())]
        .filter(item => item.isWordLike).map(item => item.segment)
      const ignored = new Set(['的', '一个', '一些', '设计', '活动', '请', '给', '我', '需要', 'a', 'the', 'for', 'and'])
      const keywords = [...new Set(terms.filter(term => !ignored.has(term)))]
      const browseOnly = !input.query && !input.category && !input.audience && !input.team
      const sources = visible()
      const matches = (browseOnly ? [] : sources).filter(item => item.collection !== 'framework')
        .filter(item => input.collection === 'all' || item.collection === input.collection)
        .filter(item => !input.team || item.owner.toLowerCase() === input.team.toLowerCase())
        .filter(item => !input.category || item.category === input.category)
        .filter(item => !input.audience || item.audiences.includes(input.audience) || item.audiences.includes('mixed'))
        .map(item => ({ ...item, citations: sourceCitations(item.document), score: keywords.reduce((score, term) => score + Number(`${item.owner} ${item.year} ${item.title} ${item.topics.join(' ')} ${categories.find(group => group.id === item.category)?.label ?? ''} ${item.practice} ${item.reflection} ${item.adaptation}`.toLowerCase().includes(term)), 0) }))
        .filter(item => keywords.length === 0 || item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      return { framework: 'WEAVE', historicalCaseCount: catalogue().historicalCaseCount,
        categories: catalogue().categories.map(group => ({ id: group.id, label: group.label,
          description: group.description, caseCount: group.cases.length,
          teams: group.cases.map(item => `${item.owner} ${item.year}`) })),
        items: matches.slice(input.offset, input.offset + input.limit), total: matches.length,
        offset: input.offset, browseOnly,
        scope: 'Sources imported into the active WetFlow run',
        note: 'Practices and reflections are attributed source summaries; an adaptation is a new planning suggestion.' }
    },
    brief(raw: unknown) {
      const input = briefInput.parse(raw), available = visible()
      const selected = input.caseIds.map(id => {
        const result = available.find(item => item.id === id)
        if (!result) throw new Error(`Education case ${id} is not available in the current run`)
        return result
      })
      if (new Set(input.caseIds).size !== input.caseIds.length) throw new Error('Choose distinct education cases')
      const resources = educationResources(input.resources, input.optionalResources)
      const comparisons = selected.map(item => ({ id: item.id, title: item.title, owner: item.owner,
        category: item.category, collection: item.collection, sourceStatus: item.status,
        source: { document: item.document, url: item.url, location: item.location, citations: sourceCitations(item.document) },
        reportedPractice: item.practice, reportedReflection: item.reflection,
        proposedAdaptation: item.adaptation,
        audienceFit: item.audiences.includes(input.audience) || item.audiences.includes('mixed'),
        resourcesToConfirm: resources.missing(item.requiredResources),
      }))
      const principle = cards.find(item => item.id === 'ouc-weave')
      return { audience: input.audience, learningGoal: input.learningGoal, availableResources: resources.available,
        optionalResources: resources.pending, unavailableResources: resources.unavailable,
        durationMinutes: input.durationMinutes,
        audienceNeeds: input.audienceNeeds ?? null,
        previousFeedback: input.previousFeedback ?? null,
        informationToConfirm: [
          ...(!input.audienceNeeds ? ['Confirm learner needs and prior knowledge with the educator.'] : []),
          ...(!input.previousFeedback ? ['No previous-activity feedback was supplied; do not invent it.'] : []),
        ],
        weaveCycle: WEAVE_CYCLE.map(stage => ({ ...stage })),
        frameworkSource: { owner: 'OUC-Haide', builtIntoPlugin: true,
          url: principle?.url ?? 'sources/OUC-EDU-WEAVE.md',
          location: principle?.location ?? 'Team-supplied WEAVE education framework',
          citations: principle ? sourceCitations(principle.document) : [] },
        comparisons,
        planningNote: 'WEAVE is the full education design, implementation, evaluation and improvement cycle, not five timed classroom segments. durationMinutes constrains the proposed classroom implementation under Action only. Source practices remain attributed; adaptations and evaluation plans are proposals, not observed learning outcomes.' }
    },
  }
}

export function apply(ctx: WetFlowContext, config: Config): void {
  const data = library.parse(JSON.parse(readFileSync(config.libraryPath, 'utf8')))
  const evidence = ctx.wetflowEvidence!
  const categoryIds = new Set(data.categories.map(item => item.id))
  if (categoryIds.size !== data.categories.length || new Set(data.cards.map(item => item.id)).size !== data.cards.length) throw new Error('Education category and case IDs must be unique')
  for (const item of data.cards.filter(item => item.collection === 'historical')) {
    if (!item.category || !categoryIds.has(item.category)) throw new Error(`Historical case ${item.id} needs a valid category`)
  }
  const sourceFolder = config.sourcesDirectory ?? educationSourcesDirectory()
  const sourceTexts = new Map(data.cards.filter(item => item.collection === 'historical' || item.collection === 'framework').map(item => {
    if (basename(item.document) !== item.document) throw new Error('Education source must be a file name')
    return [item.document, readFileSync(join(sourceFolder, item.document), 'utf8')] as const
  }))
  const ensureSources = () => {
    const existing = new Set(evidence.sources().map(source => source.name))
    for (const [document, content] of sourceTexts) if (!existing.has(document)) evidence.add(document, content, 'text/markdown')
  }
  const service = createEducationService(data.cards, () => evidence.sources().map(source => source.name), document => evidence.search(document, 12).filter(chunk => chunk.sourceName === document).map(chunk => chunk.citation), { categories: data.categories, ensureSources, bundledDocuments: [...sourceTexts.keys()] })
  ctx.reflect.provide('wetflowEducation', service)
  ctx.effect(() => ctx.wetflow.tools.mount('education', registry => {
    registry.registerInstructions('education.weave', EDUCATION_WEAVE_POLICY)
    registry.registerContext('education', budget => service.context(budget))
    registry.register({
      name: 'education_search_cases', description: 'Browse historical iGEM education categories with an empty query, or filter by team, category, topic and audience. Returns attributed source practices, reflections, status and citations, not new adaptation suggestions. Chinese and English queries are supported. Complete cases are paginated: when nextOffset is non-null, repeat the same filters with offset=nextOffset to read more. Imports bundled public summaries into the active run on first use.',
      approvalRequired: false, risk: 'LOW', mutatesState: true,
      parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 500 }, team: { type: 'string', minLength: 1, maxLength: 200, description: 'Team name from the directory, matched exactly ignoring case.' }, category: { type: 'string', enum: data.categories.map(item => item.id) }, collection: { type: 'string', enum: ['historical', 'team', 'all'] }, audience: { type: 'string', enum: ['primary', 'secondary', 'university', 'mixed'] }, limit: { type: 'integer', minimum: 1, maximum: 8 }, offset: { type: 'integer', minimum: 0, description: 'Use nextOffset returned by the preceding page; keep other filters unchanged.' } }, additionalProperties: false },
      execute: input => educationSearchObservation(service.search(input)),
    })
    registry.register({
      name: 'education_make_brief', description: 'Prepare a WEAVE education design brief. Put only educator-confirmed materials in resources; extra suggestions belong in optionalResources. comparisons contains source records; wetflowProposals contains new WetFlow suggestions that must not be attributed to source teams. WEAVE covers needs, objective-led design, implementation, evaluation and revision; durationMinutes applies only to classroom implementation under Action. When nextOffset is non-null, repeat the same inputs with offset=nextOffset to read the remaining selected cases before drafting.',
      approvalRequired: false, risk: 'LOW', mutatesState: true,
      parameters: { type: 'object', properties: { audience: { type: 'string', enum: ['primary', 'secondary', 'university', 'mixed'] }, durationMinutes: { type: 'integer', minimum: 15, maximum: 240 }, learningGoal: { type: 'string', minLength: 5, maxLength: 600 }, audienceNeeds: { type: 'string', minLength: 1, maxLength: 1200 }, previousFeedback: { type: 'string', minLength: 1, maxLength: 1200 }, resources: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 80 }, maxItems: 20, description: 'Only resources confirmed available by the educator, retaining their names. Do not add optional materials here.' }, optionalResources: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 80 }, maxItems: 20, description: 'Suggested extra resources whose availability still needs confirmation.' }, caseIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 }, offset: { type: 'integer', minimum: 0, description: 'Continue with nextOffset from the preceding page, keeping other inputs unchanged.' } }, required: ['audience', 'durationMinutes', 'learningGoal', 'resources', 'caseIds'], additionalProperties: false },
      execute: input => { const parsed = briefInput.parse(input); return educationBriefObservation(service.brief(parsed), parsed.offset) },
    })
  }), 'Education tools and lifecycle')
}
