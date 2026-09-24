import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchStore } from '../src/research/store.js'

const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})

describe('ResearchStore',()=>{
  it('persists profiles, jobs, sources and records separately by workflow run',()=>{
    const dir=mkdtempSync(join(tmpdir(),'wetflow-research-store-'));dirs.push(dir);const path=join(dir,'research.db')
    let store=new ResearchStore(path)
    const profile=store.saveProfile({runId:'wf-a',enabled:true,goal:'growth',organism:'E. coli',strain:'K12',metric:'biomass',conditions:'defined medium',customFields:[]})
    const job=store.createJob('wf-a','E. coli growth',['europepmc'],7)
    store.updateJob('wf-a',job.id,{status:'INTERRUPTED'})
    const source=store.upsertSource('wf-a',{provider:'europepmc',externalId:'PMC1',title:'Paper',url:'https://example.test',documentLevel:'fulltext',text:'0 1 2 3 4 5'})
    const record={id:'record-1',runId:'wf-a',sourceId:source.id,organism:'E. coli',strain:'K12',medium:'defined',metric:'biomass',unit:'g/L',points:[{time:0,value:3},{time:1,value:4},{time:2,value:5}],timeUnit:'h' as const,evidenceQuote:'0 1 2 3 4 5',locator:'Table 1',custom:{},createdAt:new Date().toISOString(),origin:'literature' as const,status:'EXTRACTED' as const}
    store.addRecord(record);expect(store.jobLimit('wf-a',job.id)).toBe(7);store.close()
    store=new ResearchStore(path)
    expect(store.profile('wf-a')).toEqual(profile)
    expect(store.job('wf-a',job.id).status).toBe('INTERRUPTED')
    expect(store.sources('wf-b')).toEqual([]);expect(store.records('wf-b')).toEqual([])
    expect(store.records('wf-a')).toEqual([record]);store.close()
  })

  it('recovers in-flight jobs as interrupted and deduplication preserves a fetched full text',()=>{
    const dir=mkdtempSync(join(tmpdir(),'wetflow-research-recovery-'));dirs.push(dir);const path=join(dir,'research.db')
    let store=new ResearchStore(path);const job=store.createJob('wf-a','query',['europepmc']);store.updateJob('wf-a',job.id,{status:'SEARCHING'})
    const source=store.upsertSource('wf-a',{provider:'europepmc',externalId:'id-1',doi:'10.1/a',title:'Paper',url:'https://example.test',documentLevel:'fulltext',text:'Full paper with a table'})
    store.close();store=new ResearchStore(path)
    expect(store.job('wf-a',job.id).status).toBe('INTERRUPTED')
    store.upsertSource('wf-a',{provider:'europepmc',externalId:'id-1',doi:'10.1/a',title:'Paper updated',url:'https://example.test',documentLevel:'abstract',text:'Abstract only'})
    expect(store.source('wf-a',source.id)).toMatchObject({documentLevel:'fulltext',text:'Full paper with a table'})
    store.close()
  })
})
