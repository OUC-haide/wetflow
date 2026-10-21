import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { WetFlowContext } from './types.js'

const audience = z.enum(['primary', 'secondary', 'university', 'mixed'])
const card = z.object({
  id: z.string(), owner: z.string(), year: z.number().int(), document: z.string(),
  url: z.string().min(1), location: z.string(), title: z.string(),
  audiences: z.array(audience), topics: z.array(z.string()), practice: z.string(),
  reflection: z.string(), adaptation: z.string(), requiredResources: z.array(z.string()),
})
const library = z.object({ cards: z.array(card).min(1) })
export type EducationCard = z.infer<typeof card>
export const name = 'wetflow-education'
export const inject = ['wetflow', 'wetflowEvidence']
export interface Config { libraryPath: string }

const searchInput = z.object({ query: z.string().min(1).max(500), audience: audience.optional(), limit: z.number().int().min(1).max(8).default(5) }).strict()
const briefInput = z.object({
  audience, durationMinutes: z.number().int().min(15).max(240),
  learningGoal: z.string().min(5).max(600),
  audienceNeeds: z.string().min(1).max(1200).optional(),
  previousFeedback: z.string().min(1).max(1200).optional(),
  resources: z.array(z.string().min(1).max(80)).max(20),
  caseIds: z.array(z.string()).min(1).max(6),
}).strict()

export function createEducationService(cards: EducationCard[], visibleDocuments: () => string[], sourceCitations: (document: string) => string[] = () => []) {
  const visible = () => {
    const documents = new Set(visibleDocuments())
    return cards.filter(item => documents.has(item.document))
  }
  return {
    search(raw: unknown) {
      const input = searchInput.parse(raw)
      const terms = input.query.toLowerCase().match(/[a-z0-9-]+/g) ?? []
      return { items: visible().filter(item => !input.audience || item.audiences.includes(input.audience) || item.audiences.includes('mixed'))
        .map(item => ({ ...item, citations: sourceCitations(item.document), score: terms.reduce((score, term) => score + Number(`${item.title} ${item.topics.join(' ')} ${item.practice} ${item.reflection} ${item.adaptation}`.toLowerCase().includes(term)), 0) }))
        .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, input.limit),
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
      const resources = new Set(input.resources.map(value => value.toLowerCase()))
      const comparisons = selected.map(item => ({ id: item.id, title: item.title, owner: item.owner,
        source: { document: item.document, url: item.url, location: item.location, citations: sourceCitations(item.document) },
        reportedPractice: item.practice, reportedReflection: item.reflection,
        proposedAdaptation: item.adaptation,
        audienceFit: item.audiences.includes(input.audience) || item.audiences.includes('mixed'),
        resourcesToConfirm: item.requiredResources.filter(value => !resources.has(value.toLowerCase())),
      }))
      const principle = available.find(item => item.id === 'ouc-weave')
      if (!principle) throw new Error('Import the team WEAVE framework before assembling an education brief')
      return { audience: input.audience, learningGoal: input.learningGoal, availableResources: input.resources,
        durationMinutes: input.durationMinutes,
        audienceNeeds: input.audienceNeeds ?? null,
        previousFeedback: input.previousFeedback ?? null,
        informationToConfirm: [
          ...(!input.audienceNeeds ? ['Confirm learner needs and prior knowledge with the educator.'] : []),
          ...(!input.previousFeedback ? ['No previous-activity feedback was supplied; do not invent it.'] : []),
        ],
        weaveCycle: [
          { phase: 'Wonder', question: 'Why do we design this activity?',
            purpose: 'Identify the intended audience, why it was chosen, its learning needs, questions and knowledge gaps, using project context and any available prior feedback.',
            deliverable: 'A reason for the activity and explicitly stated needs or assumptions to confirm.', status: 'planning' },
          { phase: 'Explore', question: 'How can we design for meaningful learning?',
            purpose: 'Define clear learning objectives and choose scientific content, communication methods and interactive formats suited to the audience.',
            deliverable: 'Objective-led design choices with attributed source practices and proposed adaptations.', status: 'planning' },
          { phase: 'Action', question: 'How do we bring the design to life?',
            purpose: 'Translate the design into practical online or offline actions using the available resources.',
            deliverable: 'An implementable classroom plan; its activity timings must total durationMinutes.', status: 'proposed_not_delivered' },
          { phase: 'Verify', question: 'What did participants gain?',
            purpose: 'Use participant feedback and evaluation to examine whether the intended objectives were achieved and what participants gained.',
            deliverable: 'For this prospective task, specify the evidence to collect and how to assess it; outcomes remain unmeasured.', status: 'awaiting_classroom_evidence' },
          { phase: 'Echo', question: 'What can we improve next?',
            purpose: 'Collect feedback, reflect on strengths and limitations, and translate findings into improvements implemented and evaluated in later iterations.',
            deliverable: 'A conditional feedback-to-revision plan; no completed improvement is claimed without implementation and follow-up evidence.', status: 'awaiting_feedback_and_iteration' },
        ],
        frameworkSource: { url: principle.url, location: principle.location, citations: sourceCitations(principle.document) },
        comparisons,
        planningNote: 'WEAVE is the full education design, implementation, evaluation and improvement cycle, not five timed classroom segments. durationMinutes constrains the proposed classroom implementation under Action only. Source practices remain attributed; adaptations and evaluation plans are proposals, not observed learning outcomes.' }
    },
  }
}

export function apply(ctx: WetFlowContext, config: Config): void {
  const data = library.parse(JSON.parse(readFileSync(config.libraryPath, 'utf8')))
  const evidence = ctx.wetflowEvidence!
  const service = createEducationService(data.cards, () => evidence.sources().map(source => source.name), document => evidence.search(document, 12).filter(chunk => chunk.sourceName === document).map(chunk => chunk.citation))
  ctx.reflect.provide('wetflowEducation', service)
  ctx.effect(() => ctx.wetflow.tools.mount('education', registry => {
    registry.register({
      name: 'education_search_cases', description: 'Find attributed education practices by learning topic and audience among sources imported into the active project. Returns source links, reported reflections and adaptation suggestions.',
      approvalRequired: false, risk: 'LOW', mutatesState: false,
      parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, audience: { type: 'string', enum: ['primary', 'secondary', 'university', 'mixed'] }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'], additionalProperties: false },
      execute: input => service.search(input),
    })
    registry.register({
      name: 'education_make_brief', description: 'Prepare a source-linked education design brief from selected cases, audience, goals and resources. WEAVE is the complete cycle: Wonder identifies needs and rationale; Explore designs for learning objectives; Action plans implementation; Verify plans how to evaluate participant gains; Echo plans feedback-driven revisions. It is not a five-part classroom timetable. Keep the requested duration within the Action implementation plan, and distinguish proposed evaluation from measured outcomes. The Agent writes guidance from this brief.',
      approvalRequired: false, risk: 'LOW', mutatesState: false,
      parameters: { type: 'object', properties: { audience: { type: 'string', enum: ['primary', 'secondary', 'university', 'mixed'] }, durationMinutes: { type: 'integer', minimum: 15, maximum: 240 }, learningGoal: { type: 'string', minLength: 5 }, audienceNeeds: { type: 'string', minLength: 1, maxLength: 1200 }, previousFeedback: { type: 'string', minLength: 1, maxLength: 1200 }, resources: { type: 'array', items: { type: 'string' } }, caseIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 } }, required: ['audience', 'durationMinutes', 'learningGoal', 'resources', 'caseIds'], additionalProperties: false },
      execute: input => service.brief(input),
    })
  }), 'Education tools and lifecycle')
}
