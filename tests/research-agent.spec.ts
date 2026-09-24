import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WetFlowStore } from '../src/core/store.js'
import { ToolRegistry } from '../src/agent/tools.js'
import { registerResearchTools } from '../src/agent/research-tools.js'
import { ResearchStore } from '../src/research/store.js'
import { ResearchService } from '../src/research/service.js'
import { ModelingService } from '../src/modeling/service.js'

const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
describe('native research tools and mode context',()=>{
  it('exposes metadata schemas and executes actual run-scoped service tools',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'wetflow-research-agent-'));dirs.push(dir)
    const wf=new WetFlowStore(join(dir,'wetflow.db')), rs=new ResearchStore(join(dir,'research.db'))
    const modeling=new ModelingService({dataDir:join(dir,'modeling'),validateRunId:()=>{},createPrediction:()=>({id:'p'})})
    const search=vi.fn(async()=>[])
    const service=new ResearchService({store:rs,validateRunId:id=>wf.workflowForRun(id),search,modeling:()=>modeling})
    const tools=new ToolRegistry();registerResearchTools(tools,()=>service,id=>wf.workflowForRun(typeof id==='string'?id:wf.activeWorkflowRunId()).id)
    expect(tools.definitions()).toEqual(expect.arrayContaining([expect.objectContaining({name:'research_search',parameters:expect.objectContaining({type:'object'})}),expect.objectContaining({name:'research_record_add'})]))
    const profile=await tools.get('research_profile_update').execute({enabled:true,goal:'Find biomass series',organism:'E. coli',strain:'K12',metric:'biomass',conditions:'defined medium'})
    expect(profile).toMatchObject({runId:wf.activeWorkflowRunId(),enabled:true})
    const context=service.context(wf.activeWorkflowRunId());expect(context).toContain('研究模式已启用');expect(context).toContain('已有 0 个来源和 0 条提取记录')
    expect(()=>service.context('wf-missing')).toThrow(/不存在/)
    expect(()=>tools.get('research_profile').execute({runId:'missing'})).toThrow(/不存在/)
    await service.close();wf.close();await modeling.close();rs.close()
  })

  it('uses bounded native source pages to register a later-page table and export it',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'wetflow-research-agent-pages-'));dirs.push(dir)
    const wf=new WetFlowStore(join(dir,'wetflow.db')), rs=new ResearchStore(join(dir,'research.db'))
    const modeling=new ModelingService({dataDir:join(dir,'modeling'),validateRunId:()=>{},createPrediction:()=>({id:'p'})})
    const runId=wf.activeWorkflowRunId(), article=`${'x'.repeat(3600)}\nTime(h)\tBiomass(g/L)\n0\t1\n1\t2\n2\t3\n`
    const source=rs.upsertSource(runId,{provider:'europepmc',externalId:'PMC99',title:'Long paper',url:'https://example.test/paper',documentLevel:'abstract',text:'abstract'})
    const service=new ResearchService({store:rs,validateRunId:id=>{wf.workflowForRun(id)},fetch:async()=>({level:'fulltext',text:article,url:source.url,mediaType:'text/plain',note:'Fixture document.'}),modeling:()=>modeling})
    const tools=new ToolRegistry();registerResearchTools(tools,()=>service,id=>wf.workflowForRun(typeof id==='string'?id:wf.activeWorkflowRunId()).id)
    const fetched=await tools.get('research_fetch_source').execute({sourceId:source.id}) as {total:number;text:string;hasMore:boolean;nextOffset:number}
    expect(fetched.text.length).toBeLessThanOrEqual(3500);expect(fetched.hasMore).toBe(true)
    let offset=fetched.nextOffset;let later=''
    while(offset<article.indexOf('Time(h)')) { const page=tools.get('research_source_read').execute({sourceId:source.id,offset,limit:3500}) as {text:string;nextOffset:number|null};later+=page.text;offset=page.nextOffset??article.length }
    const quote='Time(h)\tBiomass(g/L)\n0\t1\n1\t2\n2\t3'
    expect(article).toContain(quote);expect(later).toContain(quote)
    const record=tools.get('research_record_add').execute({sourceId:source.id,organism:'E. coli',strain:'K12',medium:'defined',metric:'biomass',unit:'g/L',timeUnit:'h',points:[{time:0,value:1},{time:1,value:2},{time:2,value:3}],evidenceQuote:quote,locator:'Table 4'}) as {sourceId:string;points:Array<{value:number}>}
    expect(record).toMatchObject({sourceId:source.id,points:[{value:1},{value:2},{value:3}]})
    const exported=tools.get('research_export_growth_fit').execute({recordId:rs.records(runId)[0]!.id}) as {datasetId:string}
    expect(modeling.listDatasets(runId).some(dataset=>dataset.id===exported.datasetId)).toBe(true)
    await service.close();wf.close();await modeling.close();rs.close()
  })

})
