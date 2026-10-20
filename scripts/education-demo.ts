import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWetFlowContext } from '../src/cordis.js'
import { createWetFlowPlugins, PLUGIN_IDS } from '../src/plugins/index.js'
import * as Education from '../src/plugins/education.js'

// Offline by default. A model call requires the explicit --live option.
const args = process.argv.slice(2)
const live = args.includes('--live')
const output = resolve(args.find(arg => arg !== '--live') ?? '.wetflow/demos/education')
const sources = fileURLToPath(new URL('../examples/education/', import.meta.url))
const key = live ? process.env.DEEPSEEK_API_KEY : undefined
if (live && !key) throw new Error('Set DEEPSEEK_API_KEY before using --live')
mkdirSync(output, { recursive: true })
const ctx = await createWetFlowContext({
  dbPath: join(output, 'project.db'), contextTokenBudget: 10000,
  ...(live ? {
    modelBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    modelApiKey: key!, model: 'deepseek-flash', allowDocumentExcerpts: () => true,
  } : {}),
})
try {
  const plugins = await createWetFlowPlugins(ctx, {
    experiment: { dbPath: join(output, 'experiment.db') },
    research: { dbPath: join(output, 'research.db'), modeling: () => ctx.wetflowModeling! },
    modeling: { dataDir: join(output, 'modeling'), createPrediction: () => ({ id: 'not-used' }) },
  })
  for (const id of PLUGIN_IDS) await plugins.load(id)
  ctx.wetflow.newProject('Primary-school DNA activity design')
  for (const name of readdirSync(join(sources, 'sources')).filter(name => name.endsWith('.md')))
    ctx.wetflow.store.addEvidenceSource(name, readFileSync(join(sources, 'sources', name), 'utf8'))
  const projectId = ctx.wetflow.store.activeProjectId()
  const before = ctx.wetflow.tools.list().length
  const plugin = await ctx.plugin(Education, { libraryPath: join(sources, 'education-library.json') })
  const loaded = ctx.wetflow.tools.list().length
  assert.equal(loaded, before + 2)
  const searches = []
  for (const query of ['DNA builder', 'tactile clay']) {
    searches.push(await ctx.wetflow.tools.get('education_search_cases').execute({ query, audience: 'primary' }))
  }
  const input = {
    audience: 'primary', durationMinutes: 30,
    learningGoal: 'Identify the two sides of a simple DNA model and explain one base pair using it.',
    audienceNeeds: 'A primary-school introduction; exact ages, prior knowledge and group size need educator confirmation.',
    resources: ['paper', 'colored pens', 'clay', 'laptop', 'projector'],
    caseIds: ['ouc-dna-builder', 'buct-tactile'],
  }
  const brief = await ctx.wetflow.tools.get('education_make_brief').execute(input) as {
    weaveCycle: Array<{ phase: string; status: string }>, previousFeedback: unknown,
  }
  assert.deepEqual(brief.weaveCycle.map(stage => stage.phase), ['Wonder', 'Explore', 'Action', 'Verify', 'Echo'])
  assert.ok(brief.weaveCycle.every(stage => !('minutes' in stage)))
  assert.equal(brief.previousFeedback, null)
  assert.equal(brief.weaveCycle[3]?.status, 'awaiting_classroom_evidence')
  assert.equal(brief.weaveCycle[4]?.status, 'awaiting_feedback_and_iteration')

  let modelOutput: { question: string; answer?: string; status?: string } | undefined
  if (live) {
    const question = readFileSync(join(sources, 'primary-request.txt'), 'utf8')
    const response = await ctx.wetflow.chat(question, { model: 'deepseek-flash', reasoningEffort: 'low' })
    const answer = [...response.messages].reverse().find(message => message.role === 'assistant')?.content
    modelOutput = { question, ...(answer ? { answer } : {}), ...(response.turn ? { status: response.turn.status } : {}) }
    writeFileSync(join(output, 'guidance-primary.md'), (answer ?? '') + '\n')
  }

  await plugins.unload('evidence')
  assert.equal(ctx.wetflow.tools.has('education_make_brief'), false)
  await plugins.load('evidence')
  assert.equal(ctx.wetflow.tools.has('education_make_brief'), true)
  assert.equal(ctx.wetflow.store.activeProjectId(), projectId)
  const stale = ctx.wetflow.tools.get('education_make_brief')
  await plugin.dispose()
  const unloaded = ctx.wetflow.tools.list().length
  assert.equal(unloaded, before)
  assert.throws(() => stale.execute(input), /unloaded/)
  const record = {
    passed: true, mode: live ? 'live-model' : 'offline-tools',
    lifecycle: { before, loaded, unloaded },
    projectRetained: true, dependencyRemovalAndRestoration: true, staleCallBlocked: true,
    input, searches, brief, ...(modelOutput ? { modelOutput } : {}),
    note: 'A planning demonstration; no delivered class or measured learning outcome is claimed.',
  }
  writeFileSync(join(output, 'education-results.json'), JSON.stringify(record, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, mode: record.mode, toolCounts: [before, loaded, unloaded], output }))
} finally { await ctx.fiber.dispose() }
