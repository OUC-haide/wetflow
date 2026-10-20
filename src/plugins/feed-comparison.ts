import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { z } from 'zod'
import type { WetFlowContext } from './types.js'
import type { ToolDefinition } from '../core/types.js'

const row = z.object({
  case: z.string(), feed_ratio: z.number().positive(),
  window_start_ps: z.number().nonnegative(), window_end_ps: z.number().positive(),
  near_pair_frames: z.number().int().positive(), compatible_pair_frames: z.number().int().nonnegative(),
})
const summary = z.object({
  activation_fraction_assumption: z.number().min(0).max(1),
  window_ps: z.tuple([z.number().nonnegative(), z.number().positive()]),
  rows: z.array(row).min(2),
})
const inputs = z.object({ baselineFeed: z.number().positive().default(1), comparisonFeed: z.number().positive().default(1.25) }).strict()
const rounded = (value: number) => Math.round(value * 10) / 10

export function compareFeeds(document: unknown, args: unknown) {
  const data = summary.parse(document), request = inputs.parse(args)
  if (data.window_ps[0] >= data.window_ps[1]) throw new Error('The analysis window must have positive duration')
  const seen = new Set<number>()
  const rows = data.rows.map(item => {
    if (seen.has(item.feed_ratio)) throw new Error('Feed ratios must be unique')
    seen.add(item.feed_ratio)
    if (item.window_start_ps !== data.window_ps[0] || item.window_end_ps !== data.window_ps[1]) throw new Error('All rows must use the same analysis window')
    if (item.compatible_pair_frames > item.near_pair_frames) throw new Error('Compatible contacts cannot exceed close contacts')
    return { feed: item.feed_ratio, sourceCase: item.case, closeContacts: item.near_pair_frames,
      compatibleContacts: item.compatible_pair_frames, compatibleFractionPercent: rounded(100 * item.compatible_pair_frames / item.near_pair_frames) }
  }).sort((a, b) => a.feed - b.feed)
  const baseline = rows.find(item => item.feed === request.baselineFeed)
  const comparison = rows.find(item => item.feed === request.comparisonFeed)
  if (!baseline || !comparison) throw new Error('Both requested feeds must exist in the saved report')
  return { metric: 'Compatible contact records / close-contact records',
    activationFractionAssumption: data.activation_fraction_assumption, windowPs: data.window_ps,
    rows, baseline, comparison,
    fractionChangePercentagePoints: rounded(100 * comparison.compatibleContacts / comparison.closeContacts - 100 * baseline.compatibleContacts / baseline.closeContacts) }
}

export const name = 'wetflow-feed-comparison'
export const inject = ['wetflow']
export interface Config { summaryPath: string }
export function createFeedComparisonTool(config: Config): ToolDefinition<Record<string, unknown>, unknown> {
  return {
    name: 'md_compare_feeds',
    description: 'Compare saved PMA–DA MD contact records across feeds using a common activation assumption and time window. Returns contact fractions and their difference.',
    approvalRequired: false, risk: 'LOW', mutatesState: false,
    parameters: { type: 'object', properties: { baselineFeed: { type: 'number', exclusiveMinimum: 0, default: 1 }, comparisonFeed: { type: 'number', exclusiveMinimum: 0, default: 1.25 } }, additionalProperties: false },
    execute: input => ({ sourceFile: basename(config.summaryPath), ...compareFeeds(JSON.parse(readFileSync(config.summaryPath, 'utf8')), input) }),
  }
}
export function apply(ctx: WetFlowContext, config: Config): void {
  ctx.effect(() => ctx.wetflow.tools.mount('feed-comparison', registry => registry.register(createFeedComparisonTool(config))), 'Feed-comparison tool registration')
}
