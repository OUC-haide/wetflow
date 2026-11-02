import { estimateTokens } from '../agent/context.js'
import type { EducationCard, EducationCategory } from './education.js'

/** Directory metadata only. Reading this must not import evidence sources. */
export function educationTeamContext(cards: EducationCard[], categories: EducationCategory[], tokenBudget: number) {
  const groups = new Map<string, { name: string; year: number; caseCount: number; types: string[] }>()
  for (const card of cards) {
    if (card.collection === 'framework') continue
    const key = JSON.stringify([card.owner, card.year])
    const team = groups.get(key) ?? { name: card.owner, year: card.year, caseCount: 0, types: [] }
    team.caseCount += 1
    const label = categories.find(category => category.id === card.category)?.label
    if (label && !team.types.includes(label)) team.types.push(label)
    groups.set(key, team)
  }
  const teams = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.year - b.year)
  const data = { framework: 'WEAVE', scope: 'bundled-library-and-current-run',
    totalTeams: teams.length, totalCases: teams.reduce((count, team) => count + team.caseCount, 0),
    teams: [] as typeof teams, omittedTeams: teams.length, lookupTool: 'education_search_cases' }
  const fits = () => estimateTokens(JSON.stringify(data)) <= tokenBudget
  if (!fits()) return undefined
  for (const team of teams) {
    data.teams.push(team)
    data.omittedTeams -= 1
    if (!fits()) { data.teams.pop(); data.omittedTeams += 1; break }
  }
  return data
}
