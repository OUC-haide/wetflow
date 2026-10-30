import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWetFlowContext } from '../src/cordis.js'
import { createWetFlowPlugins, PLUGIN_IDS } from '../src/plugins/index.js'
import * as FeedPlugin from '../src/plugins/feed-comparison.js'
import type { ModelResult, ModelTask } from '../src/modeling/types.js'
import { WORKFLOW_STAGES } from '../src/core/types.js'

// Reproducible engineering demonstrations. Fictional input records below are
// explicitly fixtures, never measurements from the team's wet-lab project.
const summaryPath = resolve(process.argv[2] ?? fileURLToPath(new URL('../examples/md-five-feed-summary.json', import.meta.url))), output = resolve(process.argv[3] ?? '.wetflow/demos/design')
mkdirSync(output, { recursive: true })
const temporary = mkdtempSync(join(tmpdir(), 'wetflow-design-cases-'))
const ctx = await createWetFlowContext({ dbPath: join(temporary, 'project.db') })
const cases: Record<string, unknown>[] = []
const actor = { id: 'engineering-demonstration', role: 'operator' }
const call = (name: string, args: Record<string, unknown> = {}, userMessage?: string) =>
  ctx.wetflow.tools.get(name).execute(args, userMessage ? { userMessage } : undefined)
function expectRefusal(action: () => unknown) {
  try { action() } catch (error) { return String((error as Error).message) }
  throw new Error('The invalid input was unexpectedly accepted')
}
try {
  const plugins = await createWetFlowPlugins(ctx, {
    experiment: { dbPath: join(temporary, 'experiment.db') },
    research: { dbPath: join(temporary, 'research.db'), modeling: () => ctx.wetflowModeling! },
    modeling: { dataDir: join(temporary, 'modeling'), createPrediction: () => ({ id: 'not-used' }) },
  })
  for (const id of PLUGIN_IDS) await plugins.load(id)

  // A. Extend a project with a real, domain-specific analysis capability.
  ctx.wetflow.newProject('Design validation A — saved MD analysis')
  const project = ctx.wetflow.store.activeProjectId(), before = ctx.wetflow.tools.list()
  ctx.wetflow.store.addEvidenceSource('ANALYSIS-QUESTION.md', 'Compare feed 1.00 and 1.25 in the saved PMA–DA simulation, retaining its activation assumption and analysis window.')
  const originalSources = ctx.wetflow.store.evidenceSources()
  const fiber = await ctx.plugin(FeedPlugin, { summaryPath })
  const tool = ctx.wetflow.tools.get('md_compare_feeds')
  const args = { baselineFeed: 1, comparisonFeed: 1.25 }
  const result = await tool.execute(args) as ReturnType<typeof FeedPlugin.compareFeeds>
  assert.equal(result.fractionChangePercentagePoints, -20)
  assert.equal(ctx.wetflow.tools.list().length, before.length + 1)
  await fiber.dispose()
  assert.deepEqual(ctx.wetflow.tools.list(), before)
  assert.equal(ctx.wetflow.store.activeProjectId(), project)
  assert.deepEqual(ctx.wetflow.store.evidenceSources(), originalSources)
  const staleCall = expectRefusal(() => tool.execute(args))
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'))
  const mixed = structuredClone(data); mixed.rows[4].window_start_ps = 1000
  const invalid = structuredClone(data); invalid.rows[4].compatible_pair_frames = 9999
  const mixedWindow = expectRefusal(() => FeedPlugin.compareFeeds(mixed, args))
  const impossibleCount = expectRefusal(() => FeedPlugin.compareFeeds(invalid, args))
  cases.push({ id: 'A', title: 'Add a calculation without replacing the project', inputKind: 'Previously saved MD results',
    input: args, result, sourceFile: 'md-five-feed-summary.json',
    checks: { oneNewTool: true, existingToolsRetained: true, projectRetained: true, sourcesRetained: true, mixedWindowRefused: true, impossibleCountRefused: true, staleCallBlocked: true },
    refusals: { mixedWindow, impossibleCount, staleCall } })

  // B. Two fictional protocols deliberately share a filename and query terms.
  ctx.wetflow.newProject('Design validation B — protocol A')
  const runA = ctx.wetflow.store.activeWorkflowRunId()
  const protocolA = 'ENGINEERING FIXTURE A. Sample: culture-A. Incubation temperature: 30 °C. Incubation time: 24 h. This fictional protocol is for software testing only.'
  ctx.wetflow.store.addEvidenceSource('CULTURE-SOP.md', protocolA)
  const foundA = await call('evidence_search', { query: 'CULTURE-SOP.md incubation', limit: 12 }) as { content: string; sourceName: string; citation: string }[]
  assert.equal(foundA.length, 1); assert.equal(foundA[0]!.content, protocolA)
  ctx.wetflow.newProject('Design validation B — protocol B')
  const runB = ctx.wetflow.store.activeWorkflowRunId()
  const protocolB = 'ENGINEERING FIXTURE B. Sample: culture-B. Incubation temperature: 37 °C. Incubation time: 12 h. This fictional protocol is for software testing only.'
  ctx.wetflow.store.addEvidenceSource('CULTURE-SOP.md', protocolB)
  const foundB = await call('evidence_search', { query: 'CULTURE-SOP.md incubation', limit: 12 }) as typeof foundA
  assert.equal(foundB.length, 1); assert.equal(foundB[0]!.content, protocolB)
  ctx.wetflow.switchWorkflowRun(runA)
  const recovered = await call('evidence_search', { query: 'CULTURE-SOP.md incubation', limit: 12 }) as typeof foundA
  assert.deepEqual(recovered, foundA)
  cases.push({ id: 'B', title: 'Keep similar protocols in their own projects', inputKind: 'Two fictional engineering protocols',
    inputs: [{ run: runA, text: protocolA }, { run: runB, text: protocolB }], query: 'CULTURE-SOP.md incubation',
    outputs: { projectA: foundA, projectB: foundB, switchedBackToA: recovered },
    checks: { correctProtocolInA: true, correctProtocolInB: true, noCrossProjectExcerpt: true, previousProjectRecovered: true } })

  // C. Writes go through the real Experiment Plugin and the same unit checks
  // used in its workbench. All values are declared software-test fixtures.
  ctx.wetflow.newProject('Design validation C — measurement fixtures')
  const measurementRun = ctx.wetflow.store.activeWorkflowRunId(), experiment = ctx.wetflowExperiment!.store()
  experiment.saveParameter(measurementRun, { key: 'TEMP', name: 'Fixture incubation temperature', classification: 'CPP', unit: '°C', target: 30, lowerLimit: 25, upperLimit: 35 }, actor)
  const wrongUnitInput = { parameterKey: 'TEMP', value: 30, unit: 'K' }
  const wrongUnit = expectRefusal(() => call('industrial_telemetry_record', wrongUnitInput, 'Record TEMP 30 K as an engineering test fixture.'))
  const countAfterRefusal = experiment.telemetry(measurementRun, 20).length
  assert.equal(countAfterRefusal, 0)
  const correctInput = { parameterKey: 'TEMP', value: 30, unit: '°C', reason: 'Fictional software-test fixture, not a wet-lab measurement' }
  const recorded = await call('industrial_telemetry_record', correctInput, 'Record TEMP 30 °C as an engineering test fixture.')
  const point = (recorded as { point: { value: number; unit: string } }).point
  assert.equal(point.value, 30)
  assert.equal(point.unit, '°C')
  assert.equal(experiment.telemetry(measurementRun, 20).length, 1)
  const missingValue = expectRefusal(() => call('industrial_telemetry_record', { parameterKey: 'TEMP', unit: '°C' }, 'Record TEMP in °C.'))
  assert.equal(experiment.telemetry(measurementRun, 20).length, 1)
  cases.push({ id: 'C', title: 'Check measurement meaning before storing a value', inputKind: 'Fictional measurement fixture',
    wrongUnitInput, correctInput, output: recorded, refusals: { wrongUnit, missingValue },
    checks: { inconsistentUnitRejected: true, rejectedWriteStoredNothing: countAfterRefusal === 0, explicitValueAndUnitStored: true, missingValueNotInvented: true } })

  // D. The built-in Agent creates an actual approval proposal. The operator
  // decides it through the same public runtime method used by the workbench.
  ctx.wetflow.newProject('Design validation D — researcher review')
  // Explicitly confirm the historical example route; new user runs start pending.
  await plugins.load('workflow-planner')
  const planProposal = { tool: 'workflow_set_plan', title: 'Confirm the example route',
    summary: 'Use the documented historical stages for this reproducible approval example.',
    payload: { stages: WORKFLOW_STAGES.map(stage => ({ ...stage })) } }
  const planApproval = ctx.wetflow.store.createApproval({ title: planProposal.title, summary: planProposal.summary,
    tool: planProposal.tool, risk: 'MEDIUM' }, planProposal)
  await ctx.wetflow.decide(planApproval.id, 'approve')
  const initial = ctx.wetflow.store.workflow()
  const gap = expectRefusal(() => ctx.wetflow.store.advance('ASSAY'))
  const proposed = await ctx.wetflow.chat('Advance to the next stage', { model: 'builtin' })
  assert.equal(proposed.workflow.currentStage, 'DRAFT')
  assert.equal(proposed.workflow.status, 'WAITING_APPROVAL')
  const pending = proposed.approvals.find(item => item.status === 'PENDING')!
  assert.ok(pending)
  const approved = await ctx.wetflow.decide(pending.id, 'approve')
  assert.equal(approved.workflow.currentStage, 'DESIGN_REVIEW')
  const secondProposal = await ctx.wetflow.chat('Advance to the next stage', { model: 'builtin' })
  const secondPending = secondProposal.approvals.find(item => item.status === 'PENDING')!
  const rejected = await ctx.wetflow.decide(secondPending.id, 'reject')
  assert.equal(rejected.workflow.currentStage, 'DESIGN_REVIEW')
  cases.push({ id: 'D', title: 'Keep experimental transitions under researcher review', inputKind: 'Fictional workflow run; real built-in Agent and approval methods',
    prompt: 'Advance to the next stage', output: { initial, beforeApproval: proposed.workflow, pending, afterApproval: approved.workflow, afterRejection: rejected.workflow },
    invalidTransitionMessage: gap, checks: { stageSkipRefused: true, proposalDoesNotAdvanceStage: true, approvalAdvancesOneStage: true, rejectionKeepsStage: true } })

  // E. Execute an actual numerical worker using explicitly idealized inputs.
  ctx.wetflow.newProject('Design validation E — numerical worker')
  const methods = await call('modeling_methods')
  const parameters = { initialBiomass: 0.1, initialSubstrate: 1, muMax: 1, halfSaturation: 0.1, yield: 0.5, duration: 4, timeStep: 0.1 }
  const task = await call('modeling_submit', { method: 'monod_batch', parameters, title: 'Engineering fixture: idealized batch culture', budget: { wallTimeMs: 10000, maxOutputRows: 100 } }) as ModelTask
  const deadline = Date.now() + 15000
  let state: ModelTask
  do {
    state = await call('modeling_status', { taskId: task.id }) as ModelTask
    if (!['QUEUED', 'RUNNING'].includes(state.status)) break
    if (Date.now() > deadline) throw new Error('Numerical worker did not finish within the demonstration budget')
    await new Promise(resolve => setTimeout(resolve, 30))
  } while (true)
  assert.equal(state.status, 'SUCCEEDED', state.error)
  const modelResult = await call('modeling_result', { taskId: task.id }) as ModelResult
  assert.equal(modelResult.methodVersion, state.methodVersion)
  assert.equal(modelResult.units.finalBiomass, 'g/L')
  assert.equal(modelResult.units.finalSubstrate, 'g/L')
  const artifact = ctx.wetflowModeling!.artifact(ctx.wetflow.store.activeWorkflowRunId(), task.id, 'trajectory')
  const csv = readFileSync(artifact.path, 'utf8')
  writeFileSync(join(output, 'monod-trajectory.csv'), csv)
  const lines = csv.trim().split(/\r?\n/), header = lines.shift()!.split(',')
  const rows = lines.map(line => Object.fromEntries(line.split(',').map((value, i) => [header[i]!, Number(value)])))
  assert.equal(rows.length, 41)
  const numericalColumns = Object.keys(rows[0]!)
  const biomassKey = numericalColumns.find(key => key.toLowerCase().includes('biomass'))!
  const substrateKey = numericalColumns.find(key => key.toLowerCase().includes('substrate'))!
  assert.ok(biomassKey && substrateKey)
  const pool = parameters.initialBiomass + parameters.yield * parameters.initialSubstrate
  const maxBalanceError = Math.max(...rows.map(row => Math.abs(row[biomassKey]! + parameters.yield * row[substrateKey]! - pool)))
  assert.ok(maxBalanceError < 1e-9)
  const otherProject = ctx.wetflow.store.activeWorkflowRunId()
  ctx.wetflow.newProject('Design validation E — separate run')
  const crossRunRefusal = expectRefusal(() => call('modeling_result', { taskId: task.id }))
  ctx.wetflow.switchWorkflowRun(otherProject)
  assert.deepEqual(await call('modeling_result', { taskId: task.id }), modelResult)
  cases.push({ id: 'E', title: 'Run a named numerical method with recoverable results', inputKind: 'Idealized simulation fixture, not fermentation measurements',
    input: parameters, methods, task: state, result: modelResult, trajectory: 'monod-trajectory.csv', rows: rows.length,
    first: rows[0], last: rows.at(-1), maximumMassBalanceError: maxBalanceError, crossRunRefusal,
    checks: { actualWorkerSucceeded: true, methodVersionRetained: true, unitsRetained: true, trajectoryConservesMass: true, otherRunCannotReadTask: true, originalRunRecoversResult: true } })

  const checks = cases.flatMap(item => Object.values(item.checks as Record<string, boolean>))
  assert.ok(checks.every(Boolean))
  const report = { executedAt: new Date().toISOString(), execution: 'Real WetFlow services, tool calls, built-in approval loop and Python numerical worker. No external language-model call.',
    inputProvenance: 'A reuses previously saved MD data. B–D use explicitly fictional software-test fixtures. E runs an idealized Monod model with declared inputs.',
    passed: true, caseCount: cases.length, assertions: checks.length, cases }
  writeFileSync(join(output, 'design-validation-results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, cases: cases.length, checks: checks.length, numerical: cases.at(-1) }, null, 2))
} finally {
  await ctx.fiber.dispose()
  rmSync(temporary, { recursive: true, force: true })
}
