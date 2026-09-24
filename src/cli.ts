#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import { createWetFlowContext } from './cordis.js'
import { WORKFLOW_STAGES } from './core/types.js'

const colors = {
  dim: '\x1b[2m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', reset: '\x1b[0m', bold: '\x1b[1m',
}

function renderStatus(snapshot: ReturnType<import('./agent/runtime.js').WetFlowAgent['snapshot']>): void {
  const current = WORKFLOW_STAGES.find(stage => stage.key === snapshot.workflow.currentStage)
  stdout.write(`\n${colors.bold}${snapshot.workflow.name}${colors.reset}  ${colors.cyan}${current?.label ?? snapshot.workflow.currentStage}${colors.reset}\n`)
  stdout.write(`${colors.dim}${snapshot.workflow.project} · ${snapshot.workflow.status} · ${snapshot.agentState}${colors.reset}\n`)
  const pending = snapshot.approvals.filter(item => item.status === 'PENDING')
  for (const item of pending) stdout.write(`${colors.yellow}[待审批 ${item.id}]${colors.reset} ${item.title}\n`)
}

export async function runConsole(): Promise<void> {
  const contextTokenBudget = process.env.WETFLOW_CONTEXT_TOKEN_BUDGET
    ? Number(process.env.WETFLOW_CONTEXT_TOKEN_BUDGET)
    : undefined
  const allowDocumentExcerpts = process.env.WETFLOW_ALLOW_DOCUMENT_EXCERPTS === 'true'
  const ctx = await createWetFlowContext({
    dbPath: process.env.WETFLOW_DB ?? '.wetflow/wetflow-agent.db',
    modelBaseUrl: process.env.WETFLOW_MODEL_BASE_URL ?? '',
    modelApiKey: process.env.WETFLOW_MODEL_API_KEY ?? '',
    model: process.env.WETFLOW_MODEL ?? '',
    models: (process.env.WETFLOW_MODELS ?? '').split(',').map(value => value.trim()).filter(Boolean),
    ...(contextTokenBudget ? { contextTokenBudget } : {}),
    allowDocumentExcerpts: () => allowDocumentExcerpts,
  })
  const agent = ctx.wetflow
  stdout.write(`${colors.green}${colors.bold}WetFlow Cordis Agent${colors.reset}\n输入消息，或使用 /status、/approve <id>、/reject <id>、/wake、/exit。\n文献片段云端发送：${allowDocumentExcerpts ? '已开启（WETFLOW_ALLOW_DOCUMENT_EXCERPTS=true）' : '已关闭'}\n`)
  renderStatus(agent.snapshot())

  const execute = async (input: string): Promise<boolean> => {
    if (!input) return true
    if (input === '/exit') return false
    if (input === '/status') { renderStatus(agent.snapshot()); return true }
    if (input === '/wake') { renderStatus(await agent.wake()); return true }
    const match = input.match(/^\/(approve|reject)\s+(\S+)$/)
    if (match) {
      const decision = match[1] === 'approve' ? 'approve' : 'reject'
      const snapshot = await agent.decide(match[2] ?? '', decision)
      stdout.write(`${colors.green}${snapshot.messages.at(-1)?.content ?? '完成'}${colors.reset}\n`)
      renderStatus(snapshot)
      return true
    }
    const snapshot = await agent.chat(input)
    stdout.write(`\n${snapshot.messages.at(-1)?.content ?? ''}\n`)
    renderStatus(snapshot)
    return true
  }

  if (!stdin.isTTY) {
    try {
      let source = ''
      for await (const chunk of stdin) source += String(chunk)
      for (const line of source.split(/\r?\n/)) {
        if (!await execute(line.trim())) break
      }
    } finally {
      await ctx.fiber.dispose()
    }
    return
  }

  const terminal = createInterface({ input: stdin, output: stdout })
  try {
    while (true) {
      const input = (await terminal.question('\nwetflow › ')).trim()
      if (!await execute(input)) break
    }
  } finally {
    terminal.close()
    await ctx.fiber.dispose()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runConsole()
