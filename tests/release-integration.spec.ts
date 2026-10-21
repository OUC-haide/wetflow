import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe,it,expect} from 'vitest'
import {createServer} from '../src/server.js'

describe('release integration',()=>{
 it('validates declared units across REST writes before changing records',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wetflow-write-units-'))
  const app=await createServer({dbPath:join(dir,'core.db'),settingsPath:join(dir,'model.json'),industrialDbPath:join(dir,'industrial.db'),industrialSettingsPath:join(dir,'settings.json'),researchDbPath:join(dir,'research.db'),modelingDataDir:join(dir,'modeling'),serveWeb:false})
  try {
   const defined=await app.inject({method:'POST',url:'/api/industrial/parameters',payload:{key:'TEMP',name:'Temperature',classification:'CPP',unit:'°C',target:30,lowerLimit:25,upperLimit:35}})
   expect(defined.statusCode).toBe(200)
   for(const payload of [{parameterKey:'TEMP',value:30,unit:'K'},{parameterKey:'TEMP',unit:'°C'}]){
    expect((await app.inject({method:'POST',url:'/api/industrial/telemetry',payload})).statusCode).toBe(400)
    expect((await app.inject('/api/industrial/telemetry')).json().items).toHaveLength(0)
   }
   const valid=await app.inject({method:'POST',url:'/api/industrial/telemetry',payload:{parameterKey:'TEMP',value:30}})
   expect(valid.statusCode).toBe(200);expect(valid.json().point).toMatchObject({value:30,unit:'°C'})
   const outside=await app.inject({method:'POST',url:'/api/industrial/telemetry',payload:{parameterKey:'TEMP',value:40,unit:'°C'}})
   expect(outside.statusCode).toBe(200);expect(outside.json().deviation).toBeDefined()
   expect((await app.inject('/api/industrial/telemetry')).json().items).toHaveLength(2)
  } finally {await app.close();rmSync(dir,{recursive:true,force:true})}
 })
 it('loads optional MD and Education tools in the web host and restores dependent tools',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wetflow-optional-tools-'))
  const app=await createServer({dbPath:join(dir,'core.db'),settingsPath:join(dir,'model.json'),industrialDbPath:join(dir,'industrial.db'),industrialSettingsPath:join(dir,'settings.json'),researchDbPath:join(dir,'research.db'),modelingDataDir:join(dir,'modeling'),serveWeb:false})
  const action=(id:string,verb:string)=>app.inject({method:'POST',url:`/api/plugins/${id}/${verb}`,payload:{}})
  try {
   const initial=(await app.inject('/api/plugins')).json()
   expect(initial.plugins).toHaveLength(4);expect(initial.tools).toHaveLength(35);expect(initial.extensions).toHaveLength(2)
   expect((await app.inject('/api/plugins/feed-comparison/probe')).statusCode).toBe(409)
   expect((await action('feed-comparison','load')).statusCode).toBe(200)
   const compared=await app.inject('/api/plugins/feed-comparison/probe')
   expect(compared.json().result.fractionChangePercentagePoints).toBe(-20)
   await action('feed-comparison','unload')
   expect((await app.inject('/api/plugins/feed-comparison/probe')).statusCode).toBe(409)
   await action('education','load')
   const imported=await action('education','import-examples')
   expect(imported.statusCode).toBe(200);expect(imported.json().imported).toBe(6)
   expect((await action('education','import-examples')).json().imported).toBe(0)
   const searched=(await app.inject('/api/plugins/education/probe')).json()
   expect(searched.result.items.length).toBeGreaterThan(0)
   expect(searched.result.items.every((item:{citations:string[]})=>item.citations.length>0)).toBe(true)
   const sources=(await app.inject('/api/evidence')).json()
   await action('evidence','unload')
   expect((await app.inject('/api/plugins/education/probe')).statusCode).toBe(409)
   await action('evidence','load')
   expect((await app.inject('/api/plugins/education/probe')).statusCode).toBe(200)
   expect((await app.inject('/api/evidence')).json()).toEqual(sources)
   await action('education','unload')
   expect((await app.inject('/api/plugins')).json().tools).not.toContain('education_make_brief')
  } finally {await app.close();rmSync(dir,{recursive:true,force:true})}
 })
})
