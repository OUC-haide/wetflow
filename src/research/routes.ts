import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ResearchService } from './service.js'

export type ResearchRunResolver = (candidate?: unknown) => string
const bodyObject = (value: unknown): Record<string,unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {}
function handle(reply: FastifyReply,error:unknown) {
  const message=error instanceof Error?error.message:String(error)
  return reply.code(/工作流运行不存在|研究来源不存在|研究记录不存在|研究任务不存在/.test(message)?404:400).send({error:message})
}
function requiredRun(value: unknown): string { if(typeof value!=='string'||!value.trim()) throw new Error('runId is required'); return value.trim() }
export function registerResearchRoutes(app:FastifyInstance,service:ResearchService,resolveRunId:ResearchRunResolver):void {
  app.get<{Querystring:{runId?:string}}>('/api/research/profile',async(req,reply)=>{try{return service.profile(resolveRunId(requiredRun(req.query.runId)))}catch(e){return handle(reply,e)}})
  app.put('/api/research/profile',async(req,reply)=>{try{const body=bodyObject(req.body);return service.saveProfile(resolveRunId(requiredRun(body.runId)),body)}catch(e){return handle(reply,e)}})
  app.post('/api/research/jobs',async(req,reply)=>{try{const body=bodyObject(req.body);return reply.code(202).send(service.startJob(resolveRunId(requiredRun(body.runId)),body))}catch(e){return handle(reply,e)}})
  app.get<{Querystring:{runId?:string}}>('/api/research/jobs',async(req,reply)=>{try{return service.jobs(resolveRunId(requiredRun(req.query.runId)))}catch(e){return handle(reply,e)}})
  app.post<{Params:{id:string}}>('/api/research/jobs/:id/resume',async(req,reply)=>{try{return service.resume(resolveRunId(requiredRun(bodyObject(req.body).runId)),req.params.id)}catch(e){return handle(reply,e)}})
  app.post<{Params:{id:string}}>('/api/research/jobs/:id/cancel',async(req,reply)=>{try{return service.cancel(resolveRunId(requiredRun(bodyObject(req.body).runId)),req.params.id)}catch(e){return handle(reply,e)}})
  app.get<{Querystring:{runId?:string}}>('/api/research/sources',async(req,reply)=>{try{return service.sources(resolveRunId(requiredRun(req.query.runId)))}catch(e){return handle(reply,e)}})
  app.get<{Params:{id:string};Querystring:{runId?:string}}>('/api/research/sources/:id',async(req,reply)=>{try{return service.source(resolveRunId(requiredRun(req.query.runId)),req.params.id)}catch(e){return handle(reply,e)}})
  app.post<{Params:{id:string}}>('/api/research/sources/:id/fetch',async(req,reply)=>{try{return await service.fetchSource(resolveRunId(requiredRun(bodyObject(req.body).runId)),req.params.id)}catch(e){return handle(reply,e)}})
  app.get<{Params:{id:string};Querystring:{runId?:string;offset?:string;limit?:string}}>('/api/research/sources/:id/text',async(req,reply)=>{try{return service.readSource(resolveRunId(requiredRun(req.query.runId)),req.params.id,req.query.offset===undefined?0:Number(req.query.offset),req.query.limit===undefined?3500:Number(req.query.limit))}catch(e){return handle(reply,e)}})
  app.get<{Querystring:{runId?:string}}>('/api/research/records',async(req,reply)=>{try{return service.records(resolveRunId(requiredRun(req.query.runId)))}catch(e){return handle(reply,e)}})
  app.post('/api/research/records',async(req,reply)=>{try{const body=bodyObject(req.body);return reply.code(201).send(service.addRecord(resolveRunId(requiredRun(body.runId)),body))}catch(e){return handle(reply,e)}})
  app.get<{Querystring:{runId?:string}}>('/api/research/schema',async(req,reply)=>{try{return service.schema(resolveRunId(requiredRun(req.query.runId)))}catch(e){return handle(reply,e)}})
  app.post('/api/research/query',async(req,reply)=>{try{const body=bodyObject(req.body);return service.query(resolveRunId(requiredRun(body.runId)),body.sql)}catch(e){return handle(reply,e)}})
  app.post<{Params:{id:string}}>('/api/research/records/:id/export-modeling',async(req,reply)=>{try{return reply.code(201).send(service.exportModeling(resolveRunId(requiredRun(bodyObject(req.body).runId)),req.params.id))}catch(e){return handle(reply,e)}})
}
