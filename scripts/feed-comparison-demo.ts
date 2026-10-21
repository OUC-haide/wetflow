import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createWetFlowContext } from '../src/cordis.js'
import { createWetFlowPlugins, PLUGIN_IDS } from '../src/plugins/index.js'
import * as FeedComparisonPlugin from '../src/plugins/feed-comparison.js'

const source = resolve(process.argv[2] ?? fileURLToPath(new URL('../examples/md-five-feed-summary.json', import.meta.url))), output = resolve(process.argv[3] ?? '.wetflow/demos/feeds')
const dir = mkdtempSync(join(tmpdir(), 'wetflow-feed-extension-'))
const ctx = await createWetFlowContext({ dbPath: join(dir, 'project.db') })
try {
  const plugins = await createWetFlowPlugins(ctx, {
    experiment: { dbPath: join(dir, 'experiment.db') },
    research: { dbPath: join(dir, 'research.db'), modeling: () => ctx.wetflowModeling! },
    modeling: { dataDir: join(dir, 'modeling'), createPrediction: () => ({ id: 'unused' }) },
  })
  for (const id of PLUGIN_IDS) await plugins.load(id)
  const projectId = ctx.wetflow.store.activeWorkflowRunId()
  const baselineNames = ctx.wetflow.tools.list().map(tool => tool.name)
  assert.equal(baselineNames.length, 35)
  assert.equal(ctx.wetflow.tools.has('md_compare_feeds'), false)
  const fiber = await ctx.plugin(FeedComparisonPlugin, { summaryPath: source })
  const tool = ctx.wetflow.tools.get('md_compare_feeds')
  const advertised = ctx.wetflow.tools.definitions().find(item => item.name === tool.name)
  assert.ok(advertised?.parameters)
  const started = performance.now()
  const args = { baselineFeed: 1, comparisonFeed: 1.25 }
  const result = await tool.execute(args) as ReturnType<typeof FeedComparisonPlugin.compareFeeds> & { sourceFile: string }
  const executionMs = performance.now() - started
  assert.deepEqual(result.rows.map(row => row.compatibleContacts), [10, 42, 50, 122, 24])
  assert.deepEqual([result.baseline.closeContacts, result.comparison.closeContacts], [485, 462])
  assert.deepEqual([result.baseline.compatibleFractionPercent, result.comparison.compatibleFractionPercent], [25.2, 5.2])
  assert.equal(result.fractionChangePercentagePoints, -20)
  const loadedCount = ctx.wetflow.tools.list().length
  await fiber.dispose()
  assert.deepEqual(ctx.wetflow.tools.list().map(item => item.name), baselineNames)
  assert.throws(() => tool.execute(args), /unloaded/)
  assert.equal(ctx.wetflow.store.activeWorkflowRunId(), projectId)
  const record = { executedAt: new Date().toISOString(), passed: true,
    execution: 'Real Cordis plugin mounted into the existing WetFlow Agent tool registry; direct registered-tool invocation, without an external language-model call',
    sourceFile: basename(source), sourceMetadata: { activationFractionAssumption: result.activationFractionAssumption, windowPs: result.windowPs },
    lifecycle: [{ stage: 'before', agentTools: baselineNames.length, customToolAvailable: false }, { stage: 'loaded', agentTools: loadedCount, customToolAvailable: true }, { stage: 'unloaded', agentTools: ctx.wetflow.tools.list().length, customToolAvailable: false }],
    sameProjectRetained: true, existingToolsRetained: true, staleToolCallBlocked: true,
    tool: advertised, input: args, result, executionMs,
  }
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'results.json'), JSON.stringify(record, null, 2) + '\n')
  writeFileSync(join(output, 'md-five-feed-summary.json'), readFileSync(source))
  console.log(JSON.stringify({ passed: true, toolCounts: [baselineNames.length, loadedCount, ctx.wetflow.tools.list().length], result, output }, null, 2))
} finally { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }) }
