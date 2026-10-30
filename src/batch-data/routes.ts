import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { WetFlowContext } from '../plugins/types.js'

export function registerBatchDataRoutes(app: FastifyInstance, ctx: WetFlowContext): void {
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/batch-data') && request.headers['x-wetflow-project'] && request.headers['x-wetflow-project'] !== ctx.wetflow.store.activeProjectId()) {
      return reply.code(409).send({ error: '当前项目已切换，请刷新数据面板后再操作。' })
    }
  })
  const project = () => ctx.wetflow.store.activeProjectId()
  const run = () => ctx.wetflow.store.activeWorkflowRunId()
  const service = () => {
    if (!ctx.wetflowBatchData) throw new Error('多批次数据插件未启用。')
    return ctx.wetflowBatchData
  }
  const get = (path: string, handle: (query: Record<string, unknown>, params: Record<string, string>) => unknown) => {
    app.get<{ Querystring: Record<string, unknown>; Params: Record<string, string> }>(path, async (req, reply) => {
      if (!ctx.wetflowBatchData) return reply.code(503).send({ error: '请先在插件管理中启用多批次数据插件。' })
      try { return handle(req.query, req.params) } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }) }
    })
  }
  const post = (path: string, handle: (body: unknown, params: Record<string, string>) => unknown) => {
    app.post<{ Body: unknown; Params: Record<string, string> }>(path, async (req, reply) => {
      if (!ctx.wetflowBatchData) return reply.code(503).send({ error: '多批次数据插件未启用。' })
      if (ctx.wetflow.snapshot().agentState === 'THINKING') return reply.code(409).send({ error: '请等待当前 Agent 操作完成后再修改数据。' })
      try { return handle(req.body, req.params) } catch (error) {
        return reply.code(400).send({ error: error instanceof z.ZodError ? error.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('；') : error instanceof Error ? error.message : String(error) })
      }
    })
  }
  get('/api/batch-data/catalog', () => service().catalogue(project()))
  get('/api/batch-data/records', query => service().records(project(), z.object({
    batchId: z.string().optional(), metricId: z.string().optional(), sample: z.string().optional(),
    offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100),
  }).parse(query)))
  get('/api/batch-data/records/:id/history', (_, params) => service().history(project(), params.id!))
  get('/api/batch-data/compare', query => {
    const { leftId, rightId } = z.object({ leftId: z.string().min(1), rightId: z.string().min(1) }).parse(query)
    return service().compare(project(), leftId, rightId)
  })
  get('/api/batch-data/export', query => ({ csv: service().export(project(), z.string().min(1).parse(query.batchId)) }))
  post('/api/batch-data/rounds', body => service().addRound(project(), run(), body))
  post('/api/batch-data/batches', body => service().addBatch(project(), run(), body))
  post('/api/batch-data/metrics', body => service().addMetric(project(), body))
  post('/api/batch-data/records', body => service().record(project(), run(), body))
  post('/api/batch-data/records/:id/correct', (body, params) => service().correct(project(), params.id!, body))
  const importInput = z.object({ batchId: z.string().min(1), csv: z.string().max(1_000_000) }).strict()
  post('/api/batch-data/import/preview', body => { const { batchId, csv } = importInput.parse(body); return service().preview(project(), batchId, csv) })
  post('/api/batch-data/import', body => { const { batchId, csv } = importInput.parse(body); return service().import(project(), run(), batchId, csv) })
}
