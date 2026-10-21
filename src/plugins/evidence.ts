import type { EvidenceService, WetFlowContext } from './types.js'

export const name = 'wetflow-evidence'
export const inject = ['wetflow']
export function apply(ctx: WetFlowContext): void {
  const store = ctx.wetflow.store
  const service: EvidenceService = {
    sources: () => store.evidenceSources(),
    search: (query, limit) => store.searchEvidence(query, limit),
    add: (name, content, mimeType) => store.addEvidenceSource(name, content, mimeType),
  }
  ctx.reflect.provide('wetflowEvidence', service)
  ctx.effect(() => ctx.wetflow.tools.mount('evidence', registry => {
    registry.register({
      name: 'evidence_sources', description: 'List imported source names and metadata for the current workflow run.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      approvalRequired: false, risk: 'LOW', mutatesState: false, execute: () => service.sources(),
    })
    registry.register({
      name: 'evidence_search', description: 'Search local source chunks and return excerpts with their source citations.',
      parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 1000 }, limit: { type: 'integer', minimum: 1, maximum: 12 } }, required: ['query'], additionalProperties: false },
      approvalRequired: false, risk: 'LOW', mutatesState: false,
      execute: input => service.search(String(input.query), typeof input.limit === 'number' ? input.limit : 4),
    })
  }), 'Evidence tools')
}
