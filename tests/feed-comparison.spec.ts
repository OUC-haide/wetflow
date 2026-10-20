import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compareFeeds } from '../src/plugins/feed-comparison.js'

const file = new URL('../examples/md-five-feed-summary.json', import.meta.url)
const source = () => JSON.parse(readFileSync(file, 'utf8'))
describe('PMA–DA feed comparison extension', () => {
  it('recomputes the recorded contact fractions from the original counts', () => {
    const result = compareFeeds(source(), { baselineFeed: 1, comparisonFeed: 1.25 })
    expect(result.rows.map(item => item.compatibleFractionPercent)).toEqual([14.5, 9.1, 25.3, 25.2, 5.2])
    expect(result.fractionChangePercentagePoints).toBe(-20)
    expect(result.windowPs).toEqual([3000, 5000])
    expect(result.activationFractionAssumption).toBe(0.5)
  })
  it('rejects a comparison that silently mixes analysis windows', () => {
    const data = source(); data.rows[4].window_start_ps = 1000
    expect(() => compareFeeds(data, {})).toThrow('same analysis window')
  })
  it('rejects undefined contact fractions, impossible counts and absent feeds', () => {
    const zero = source(); zero.rows[0].near_pair_frames = 0
    expect(() => compareFeeds(zero, {})).toThrow()
    const impossible = source(); impossible.rows[0].compatible_pair_frames = 70
    expect(() => compareFeeds(impossible, {})).toThrow('cannot exceed')
    expect(() => compareFeeds(source(), { comparisonFeed: 2 })).toThrow('must exist')
  })
})
