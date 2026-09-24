import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from '../src/server.js'
const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
describe('research REST API',()=>{
  it('validates explicit run scope, persists the profile, and exposes the restricted SQL schema',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'wetflow-research-server-'));dirs.push(dir)
    const app=await createServer({dbPath:join(dir,'workflow.db'),researchDbPath:join(dir,'research.db'),serveWeb:false})
    try {
      const runId=(await app.inject({method:'GET',url:'/api/workspace'})).json().activeWorkflowRunId as string
      expect((await app.inject({method:'GET',url:'/api/research/profile'})).statusCode).toBe(400)
      const saved=await app.inject({method:'PUT',url:'/api/research/profile',payload:{runId,enabled:true,goal:'Compare biomass',organism:'E. coli',strain:'K12',metric:'biomass',conditions:'defined medium',customFields:[]}})
      expect(saved.statusCode).toBe(200);expect(saved.json()).toMatchObject({runId,enabled:true,goal:'Compare biomass'})
      const schema=await app.inject({method:'GET',url:`/api/research/schema?runId=${encodeURIComponent(runId)}`})
      expect(schema.statusCode).toBe(200);expect(schema.json().tables.map((table:{name:string})=>table.name)).toEqual(['measurements','records','sources'])
      const query=await app.inject({method:'POST',url:'/api/research/query',payload:{runId,sql:'SELECT * FROM industrial_parameters'}})
      expect(query.statusCode).toBe(400)
      const foreign=await app.inject({method:'GET',url:'/api/research/records?runId=missing-run'})
      expect(foreign.statusCode).toBe(404)
      const missingSource=await app.inject({method:'GET',url:'/api/research/sources/absent?runId='+encodeURIComponent(runId)})
      expect(missingSource.statusCode).toBe(404)
    } finally {await app.close()}
  })
})
