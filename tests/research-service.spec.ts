import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchStore } from '../src/research/store.js'
import { ResearchService } from '../src/research/service.js'
import { ModelingService } from '../src/modeling/service.js'
import type { SearchHit } from '../src/research/providers.js'

const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
const waitFor=async(check:()=>boolean)=>{for(let i=0;i<100&&!check();i++)await new Promise(r=>setTimeout(r,5));if(!check())throw new Error('Timed out waiting for research job')}
function fixture(){const dir=mkdtempSync(join(tmpdir(),'wetflow-research-service-'));dirs.push(dir);const store=new ResearchStore(join(dir,'research.db'));const modeling=new ModelingService({dataDir:join(dir,'modeling'),validateRunId:()=>{},createPrediction:()=>({id:'p1'})});const validateRunId=vi.fn((id:string)=>{if(!['wf-a','wf-b'].includes(id))throw new Error('工作流运行不存在。')});return {dir,store,modeling,validateRunId}}
const hit:SearchHit={provider:'europepmc',externalId:'PMC42',title:'Growth curve',url:'https://example.test/paper',abstract:'metadata abstract',doi:'10.1/example'}

describe('ResearchService',()=>{
  it('runs, fetches and provenance-checks extracted records, queries safely, and exports a real dataset',async()=>{
    const f=fixture();const search=vi.fn(async()=>[hit]);const fetch=vi.fn(async()=>({level:'fulltext' as const,text:'Table 2: at 0 h biomass 3 g/L, at 1 h biomass 4 g/L, at 2 h biomass 5 g/L.',url:hit.url,mediaType:'text/plain',note:'Full text truncated at 100,000 characters.'}));const service=new ResearchService({store:f.store,validateRunId:f.validateRunId,search,fetch,modeling:()=>f.modeling})
    const profile=service.saveProfile('wf-a',{enabled:true,goal:'growth',organism:'E. coli',strain:'K12',metric:'biomass',conditions:'defined medium',customFields:[]});expect(profile.enabled).toBe(true)
    const job=service.startJob('wf-a',{query:'E. coli growth',providers:['europepmc'],limit:4});await waitFor(()=>service.job('wf-a',job.id).status==='COMPLETED');expect(service.job('wf-a',job.id).found).toBe(1)
    const source=service.sources('wf-a').items[0]!;expect(source.documentLevel).toBe('abstract');const acquired=await service.fetchSource('wf-a',source.id);expect(acquired.documentLevel).toBe('fulltext');expect(acquired.note).toContain('truncated')
    expect(()=>service.addRecord('wf-a',{sourceId:source.id,organism:'E. coli',strain:'K12',medium:'defined',metric:'biomass',unit:'g/L',timeUnit:'h',points:[{time:0,value:5},{time:1,value:3},{time:2,value:4}],evidenceQuote:'Table 2: at 0 h biomass 3 g/L, at 1 h biomass 4 g/L, at 2 h biomass 5 g/L.',locator:'Table 2'})).toThrow(/pair must appear together/)
    const record=service.addRecord('wf-a',{sourceId:source.id,organism:'E. coli',strain:'K12',medium:'defined',metric:'biomass',unit:'g/L',timeUnit:'h',points:[{time:0,value:3},{time:1,value:4},{time:2,value:5}],evidenceQuote:'Table 2: at 0 h biomass 3 g/L, at 1 h biomass 4 g/L, at 2 h biomass 5 g/L.',locator:'Table 2'})
    expect(service.query('wf-a','SELECT time, value FROM measurements ORDER BY time')).toMatchObject({columns:['time','value'],rows:[{time:0,value:3},{time:1,value:4},{time:2,value:5}],truncated:false})
    expect(service.query('wf-a','SELECT count(*) FROM measurements')).toMatchObject({columns:['count(*)'],rows:[{'count(*)':3}]})
    expect(service.query('wf-a','SELECT value FROM measurements LIMIT 2')).toMatchObject({rows:[{value:3},{value:4}],truncated:true})
    expect(()=>service.query('wf-a','SELECT * FROM measurements; DROP TABLE records')).toThrow(/restricted SELECT/)
    expect(()=>service.source('wf-b',source.id)).toThrow(/不存在/)
    const exported=service.exportModeling('wf-a',record.id);expect(f.modeling.listDatasets('wf-a')).toEqual([expect.objectContaining({id:exported.datasetId,rowCount:3})]);expect(exported).toMatchObject({format:'text/csv',fields:['time','biomass'],sourceCitation:{sourceId:source.id,doi:'10.1/example',licenseStatus:'unknown'}});expect(service.exportModeling('wf-a',record.id)).toEqual(exported);expect(service.records('wf-a').items[0]?.exportedDatasetIds).toContain(exported.datasetId)
    await service.close();await f.modeling.close();f.store.close()
  })

  it('carries article rights metadata through source reads and exports only numeric columns with citation provenance',async()=>{
    const f=fixture();const licensedHit={...hit,licenseStatus:'known' as const,license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',copyright:'© 2025 Authors'}
    const quote='0 h 1 g/L; 1 h 2 g/L; 2 h 3 g/L'
    const service=new ResearchService({store:f.store,validateRunId:f.validateRunId,search:async()=>[licensedHit],fetch:async()=>({level:'fulltext',text:quote,url:licensedHit.url,mediaType:'text/plain'}) ,modeling:()=>f.modeling})
    const job=service.startJob('wf-a',{query:'growth'});await waitFor(()=>service.job('wf-a',job.id).status==='COMPLETED')
    const source=service.sources('wf-a').items[0]!;expect(source).toMatchObject({licenseStatus:'known',license:'CC BY 4.0'});await service.fetchSource('wf-a',source.id)
    expect(service.readSource('wf-a',source.id)).toMatchObject({licenseStatus:'known',licenseUrl:licensedHit.licenseUrl,copyright:licensedHit.copyright,doi:hit.doi})
    expect(service.query('wf-a','SELECT license_status, license_url FROM sources')).toMatchObject({rows:[{license_status:'known',license_url:licensedHit.licenseUrl}]})
    const record=service.addRecord('wf-a',{sourceId:source.id,organism:'E. coli',strain:'K12',medium:'defined',metric:'biomass',unit:'g/L',timeUnit:'h',points:[{time:0,value:1},{time:1,value:2},{time:2,value:3}],evidenceQuote:quote,locator:'Table 1'})
    expect(service.exportModeling('wf-a',record.id)).toMatchObject({format:'text/csv',fields:['time','biomass'],sourceCitation:{doi:hit.doi,licenseStatus:'known',license:'CC BY 4.0',licenseUrl:licensedHit.licenseUrl,copyright:licensedHit.copyright}})
    await service.close();await f.modeling.close();f.store.close()
  })

  it('keeps geo metadata distinct, scopes source ids, and interrupts/resumes with persisted limit',async()=>{
    const f=fixture();let call=0;let markStarted!:()=>void;const started=new Promise<void>(resolve=>{markStarted=resolve});const geoHit={...hit,provider:'geo' as const,externalId:'GSE123'}
    const search=vi.fn(async(_p,_q,_l,signal?:AbortSignal)=>{call++;if(call===1){markStarted();await new Promise<void>(resolve=>{signal?.addEventListener('abort',()=>resolve(),{once:true})})}return [geoHit]})
    const fetch=vi.fn(async()=>({level:'metadata' as const,text:'GEO metadata',url:geoHit.url,mediaType:'text/plain'}))
    const service=new ResearchService({store:f.store,validateRunId:f.validateRunId,search,fetch,modeling:()=>f.modeling})
    const job=service.startJob('wf-a',{query:'growth',providers:['geo'],limit:3});await started;service.cancel('wf-a',job.id);await waitFor(()=>service.job('wf-a',job.id).status==='CANCELLED')
    const retry=service.resume('wf-a',job.id);expect(retry.status).toBe('QUEUED');expect(f.store.jobLimit('wf-a',job.id)).toBe(3);await waitFor(()=>['COMPLETED','PARTIAL','FAILED'].includes(service.job('wf-a',job.id).status))
    const source=service.sources('wf-a').items[0]!;await service.fetchSource('wf-a',source.id);expect(service.source('wf-a',source.id).documentLevel).toBe('metadata')
    expect(()=>service.addRecord('wf-a',{sourceId:source.id,metric:'biomass',unit:'g/L',timeUnit:'h',points:[{time:0,value:1},{time:1,value:2},{time:2,value:3}],evidenceQuote:'0 1 2 3',locator:'table'})).toThrow(/全文或数据集/)
    await service.close();await f.modeling.close();f.store.close()
  })
})
