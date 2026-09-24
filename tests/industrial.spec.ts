import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from '../src/server.js'
import { IndustrialStore } from '../src/industrial/index.js'

const temporary: string[] = []

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workingDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

async function industrialServer() {
  const dir = workingDir('wetflow-industrial-')
  const app = await createServer({
    dbPath: join(dir, 'wetflow.db'),
    industrialSettingsPath: join(dir, 'industrial-settings.json'),
    industrialDbPath: join(dir, 'industrial.db'),
    serveWeb: false,
  })
  return { app, dir }
}

describe('WetFlow industrial surface', () => {
  it('records a batch profile and reports it in the overview', async () => {
    const { app } = await industrialServer()
    try {
      const saved = await app.inject({
        method: 'PUT', url: '/api/industrial/profile',
        payload: { batchNumber: 'B-2026-001', productName: 'PYC 裂解酶', facility: '上海一厂', mode: 'SHADOW', status: 'PLANNED' },
      })
      expect(saved.statusCode).toBe(200)
      expect(saved.json()).toMatchObject({ batchNumber: 'B-2026-001', mode: 'SHADOW', status: 'PLANNED' })

      const overview = await app.inject({ method: 'GET', url: '/api/industrial/overview' })
      expect(overview.statusCode).toBe(200)
      const body = overview.json()
      expect(body.profile).toMatchObject({ batchNumber: 'B-2026-001' })
      expect(body.counts.parameters).toBe(0)
      expect(body.executionPolicy).toEqual({
        phase: 'SHADOW',
        writesEnabled: false,
        identityMode: 'development-header',
        message: expect.stringContaining('不向任何生产系统写入'),
      })
      expect(body.audit).toMatchObject({ valid: true })
      expect(body.audit.records).toBeGreaterThanOrEqual(1)

      const audit = await app.inject({ method: 'GET', url: '/api/industrial/audit' })
      expect(audit.json().chain.valid).toBe(true)
      expect(audit.json().items[0]).toMatchObject({ action: 'BATCH_PROFILE_CREATED', entityType: 'batch' })
    } finally {
      await app.close()
    }
  })

  it('refuses genealogy links whose nodes are unknown and accepts linked records', async () => {
    const { app } = await industrialServer()
    try {
      const orphan = await app.inject({
        method: 'POST', url: '/api/industrial/genealogy',
        payload: { sourceType: 'BIOLOGICAL_ENTITY', sourceId: 'entity-missing', targetType: 'MATERIAL_LOT', targetId: 'lot-missing', relationship: 'CONSUMED_IN' },
      })
      expect(orphan.statusCode).toBe(400)
      expect(orphan.json().error).toContain('谱系节点不存在')

      const entity = await app.inject({
        method: 'POST', url: '/api/industrial/entities',
        payload: { kind: 'STRAIN', name: 'PYC-01', externalId: 'EXT-1', version: 'v1' },
      })
      expect(entity.statusCode).toBe(200)
      const lot = await app.inject({
        method: 'POST', url: '/api/industrial/lots',
        payload: { kind: 'MEDIA', name: 'TB 培养基', lotNumber: 'L-77', supplier: '内部', quantity: 5, unit: 'L' },
      })
      expect(lot.statusCode).toBe(200)

      const link = await app.inject({
        method: 'POST', url: '/api/industrial/genealogy',
        payload: {
          sourceType: 'BIOLOGICAL_ENTITY', sourceId: entity.json().id,
          targetType: 'MATERIAL_LOT', targetId: lot.json().id,
          relationship: 'CONSUMED_IN', quantity: 2, unit: 'L',
        },
      })
      expect(link.statusCode).toBe(200)
      expect(link.json()).toMatchObject({ relationship: 'CONSUMED_IN', quantity: 2 })

      const listed = await app.inject({ method: 'GET', url: '/api/industrial/genealogy' })
      expect(listed.json().items).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it('opens an automatic deviation when telemetry leaves the parameter limits', async () => {
    const { app } = await industrialServer()
    try {
      await app.inject({
        method: 'POST', url: '/api/industrial/parameters',
        payload: { key: 'TEMP', name: '发酵温度', classification: 'CPP', unit: '°C', target: 25, lowerLimit: 20, upperLimit: 30 },
      })

      const breach = await app.inject({
        method: 'POST', url: '/api/industrial/telemetry',
        payload: { parameterKey: 'TEMP', value: 34, unit: '°C' },
      })
      expect(breach.statusCode).toBe(200)
      expect(breach.json().deviation).toMatchObject({ source: 'AUTO_LIMIT', severity: 'HIGH', status: 'OPEN', observedValue: 34 })
      const deviationId = breach.json().deviation.id

      const repeated = await app.inject({
        method: 'POST', url: '/api/industrial/telemetry',
        payload: { parameterKey: 'TEMP', value: 35, unit: '°C' },
      })
      expect(repeated.json().deviation).toMatchObject({ id: deviationId, observedValue: 35 })

      const open = await app.inject({ method: 'GET', url: '/api/industrial/deviations?status=OPEN' })
      expect(open.json().items).toHaveLength(1)

      const resolved = await app.inject({
        method: 'PATCH', url: `/api/industrial/deviations/${deviationId}`,
        payload: { status: 'RESOLVED', resolution: '已复核，属探头漂移' },
      })
      expect(resolved.statusCode).toBe(200)
      expect(resolved.json()).toMatchObject({ status: 'RESOLVED', resolution: '已复核，属探头漂移' })
      expect(resolved.json().resolvedAt).toBeTruthy()

      await app.inject({
        method: 'POST', url: '/api/industrial/telemetry',
        payload: { parameterKey: 'TEMP', value: 36, unit: '°C' },
      })
      const deviations = await app.inject({ method: 'GET', url: '/api/industrial/deviations' })
      expect(deviations.json().items).toHaveLength(2)
    } finally {
      await app.close()
    }
  })

  it('keeps industrial actions behind an approval boundary', async () => {
    const { app } = await industrialServer()
    try {
      const readOnly = await app.inject({
        method: 'POST', url: '/api/industrial/connectors',
        payload: { name: '产量 MES', kind: 'MES', mode: 'READ_ONLY', status: 'ONLINE', endpoint: 'https://mes.internal' },
      })
      expect(readOnly.statusCode).toBe(200)

      const refused = await app.inject({
        method: 'POST', url: '/api/industrial/actions',
        payload: { connectorId: readOnly.json().id, operation: 'hold-batch', risk: 'HIGH' },
      })
      expect(refused.statusCode).toBe(400)
      expect(refused.json().error).toContain('READ_ONLY')

      const propose = await app.inject({
        method: 'POST', url: '/api/industrial/connectors',
        payload: { name: '工艺 OPC UA', kind: 'OPC_UA', mode: 'PROPOSE', status: 'ONLINE', endpoint: 'opc.tcp://10.0.0.9:4840' },
      })
      const action = await app.inject({
        method: 'POST', url: '/api/industrial/actions',
        headers: { 'x-wetflow-actor': 'alice', 'x-wetflow-role': 'engineer' },
        payload: { connectorId: propose.json().id, operation: 'setpoint-adjust', risk: 'HIGH', reason: '溶氧偏低', payload: { setpoint: 30 } },
      })
      expect(action.statusCode).toBe(200)
      expect(action.json()).toMatchObject({ status: 'PENDING', requiredApprovals: 2, dispatchPermitted: false })
      const actionId = action.json().id

      const first = await app.inject({
        method: 'POST', url: `/api/industrial/actions/${actionId}/decisions`,
        headers: { 'x-wetflow-actor': 'alice', 'x-wetflow-role': 'engineer' },
        payload: { decision: 'APPROVE', comment: '同意' },
      })
      expect(first.json()).toMatchObject({ status: 'PENDING', dispatchPermitted: false })
      expect(first.json().decisions).toHaveLength(1)

      const duplicated = await app.inject({
        method: 'POST', url: `/api/industrial/actions/${actionId}/decisions`,
        headers: { 'x-wetflow-actor': 'alice', 'x-wetflow-role': 'engineer' },
        payload: { decision: 'APPROVE' },
      })
      expect(duplicated.statusCode).toBe(400)
      expect(duplicated.json().error).toContain('重复表决')

      const second = await app.inject({
        method: 'POST', url: `/api/industrial/actions/${actionId}/decisions`,
        headers: { 'x-wetflow-actor': 'bob', 'x-wetflow-role': 'qa' },
        payload: { decision: 'APPROVE', comment: 'QA 通过' },
      })
      expect(second.json()).toMatchObject({ status: 'APPROVED', dispatchPermitted: false })

      const settled = await app.inject({
        method: 'POST', url: `/api/industrial/actions/${actionId}/decisions`,
        headers: { 'x-wetflow-actor': 'carol' },
        payload: { decision: 'APPROVE' },
      })
      expect(settled.statusCode).toBe(400)

      const audit = await app.inject({ method: 'GET', url: '/api/industrial/audit' })
      const actions = audit.json().items.map((item: { action: string }) => item.action)
      expect(actions).toContain('ACTION_PROPOSED')
      expect(actions).toContain('ACTION_APPROVE_RECORDED')
      expect(audit.json().chain.valid).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('exposes industrial settings without enabling production writes', async () => {
    const { app, dir } = await industrialServer()
    try {
      const initial = await app.inject({ method: 'GET', url: '/api/industrial/settings' })
      expect(initial.json().settings).toMatchObject({
        api: { defaultMode: 'READ_ONLY' },
        executionWritesEnabled: false,
        restartRequired: false,
      })

      const invalid = await app.inject({
        method: 'PATCH', url: '/api/industrial/settings',
        payload: { api: { defaultMode: 'AUTONOMOUS' } },
      })
      expect(invalid.statusCode).toBe(400)

      const updated = await app.inject({
        method: 'PATCH', url: '/api/industrial/settings',
        payload: { api: { defaultMode: 'PROPOSE', requestTimeoutMs: 20_000 }, database: { path: join(dir, 'moved.db') } },
      })
      expect(updated.statusCode).toBe(200)
      expect(updated.json().settings).toMatchObject({
        api: { defaultMode: 'PROPOSE', requestTimeoutMs: 20_000 },
        restartRequired: true,
        executionWritesEnabled: false,
      })
      expect(updated.json().settings.activeDatabasePath).toBe(join(dir, 'industrial.db'))
      expect(updated.json().settings.settingsPath).toBe(join(dir, 'industrial-settings.json'))
    } finally {
      await app.close()
    }
  })

  it('rejects industrial records for an unknown workflow run', async () => {
    const { app } = await industrialServer()
    try {
      const missing = await app.inject({ method: 'GET', url: '/api/industrial/overview?runId=run-does-not-exist' })
      expect(missing.statusCode).toBe(404)
      expect(missing.json().error).toBe('工作流运行不存在。')
    } finally {
      await app.close()
    }
  })
})

describe('industrial audit chain', () => {
  it('detects a tampered audit row', () => {
    const dir = workingDir('wetflow-industrial-audit-')
    const dbPath = join(dir, 'industrial.db')
    const store = new IndustrialStore(dbPath)
    try {
      store.addLot('run-test', { kind: 'MEDIA', name: 'TB', lotNumber: 'L-1' }, { id: 'alice', role: 'engineer' })
      store.addLot('run-test', { kind: 'FEED', name: '葡萄糖', lotNumber: 'L-2' }, { id: 'alice', role: 'engineer' })
      const chain = store.auditChain('run-test')
      expect(chain).toMatchObject({ valid: true, records: 2 })
      expect(chain.headHash).toHaveLength(64)
    } finally {
      store.close()
    }

    const raw = new DatabaseSync(dbPath)
    raw.prepare("UPDATE industrial_audit SET reason = 'tampered' WHERE workflow_run_id = ? AND sequence = 1").run('run-test')
    raw.close()

    const reopened = new IndustrialStore(dbPath)
    try {
      expect(reopened.auditChain('run-test').valid).toBe(false)
    } finally {
      reopened.close()
    }
  })
})

describe('model prediction ledger', () => {
  it('records a prediction as PROPOSED and counts it as pending', async () => {
    const { app } = await industrialServer()
    try {
      const created = await app.inject({
        method: 'POST', url: '/api/industrial/predictions',
        headers: { 'x-wetflow-actor': 'modeler', 'x-wetflow-role': 'dry-lab' },
        payload: {
          model: 'MD/MM-GBSA', artifactRef: 'wiki_model_methods_EN.md#3',
          prediction: 'Overexpressing the transcription factor raises xylose consumption.',
          conditions: 'xylose as sole carbon source', uncertainty: 'difference within error',
          linkedExperiment: 'shake-flask A08 run',
        },
      })
      expect(created.statusCode).toBe(200)
      expect(created.json()).toMatchObject({ status: 'PROPOSED', model: 'MD/MM-GBSA', artifactRef: 'wiki_model_methods_EN.md#3' })
      expect(created.json().testedAt).toBeUndefined()

      const listed = await app.inject({ method: 'GET', url: '/api/industrial/predictions' })
      expect(listed.json().items).toHaveLength(1)

      const overview = await app.inject({ method: 'GET', url: '/api/industrial/overview' })
      expect(overview.json().counts.pendingPredictions).toBe(1)
    } finally {
      await app.close()
    }
  })

  it('refuses to confirm a prediction that was never tested', async () => {
    const { app } = await industrialServer()
    try {
      const id = (await app.inject({
        method: 'POST', url: '/api/industrial/predictions',
        payload: { model: 'MD', prediction: 'Motif A binds more tightly than motif B.' },
      })).json().id

      const premature = await app.inject({
        method: 'PATCH', url: `/api/industrial/predictions/${id}`,
        payload: { status: 'CONFIRMED', note: 'looks right' },
      })
      expect(premature.statusCode).toBe(400)
      expect(premature.json().error).toContain('必须先标记为 TESTED')

      const still = await app.inject({ method: 'GET', url: '/api/industrial/predictions' })
      expect(still.json().items[0]).toMatchObject({ status: 'PROPOSED' })
    } finally {
      await app.close()
    }
  })

  it('keeps a refuted prediction visible with its resolution note', async () => {
    const { app } = await industrialServer()
    try {
      const id = (await app.inject({
        method: 'POST', url: '/api/industrial/predictions',
        payload: { model: 'MD', prediction: 'The engineered strain will outproduce the wild type.' },
      })).json().id

      const tested = await app.inject({ method: 'PATCH', url: `/api/industrial/predictions/${id}`, payload: { status: 'TESTED', note: 'fermentation started' } })
      expect(tested.json().status).toBe('TESTED')
      expect(tested.json().testedAt).toBeTruthy()

      const refuted = await app.inject({ method: 'PATCH', url: `/api/industrial/predictions/${id}`, payload: { status: 'REFUTED', note: 'titer unchanged' } })
      expect(refuted.json()).toMatchObject({ status: 'REFUTED', resolutionNote: 'titer unchanged' })
      expect(refuted.json().resolvedAt).toBeTruthy()

      const listed = await app.inject({ method: 'GET', url: '/api/industrial/predictions' })
      expect(listed.json().items).toHaveLength(1)
      expect(listed.json().items[0].prediction).toContain('outproduce')

      const closed = await app.inject({ method: 'PATCH', url: `/api/industrial/predictions/${id}`, payload: { status: 'TESTED' } })
      expect(closed.statusCode).toBe(400)
      expect(closed.json().error).toContain('已结束的预测')

      const overview = await app.inject({ method: 'GET', url: '/api/industrial/overview' })
      expect(overview.json().counts.pendingPredictions).toBe(0)
    } finally {
      await app.close()
    }
  })

  it('writes every prediction transition into the audit chain', async () => {
    const { app } = await industrialServer()
    try {
      const id = (await app.inject({
        method: 'POST', url: '/api/industrial/predictions',
        payload: { model: 'MD', prediction: 'A structural change explains the switch.' },
      })).json().id
      await app.inject({ method: 'PATCH', url: `/api/industrial/predictions/${id}`, payload: { status: 'TESTED' } })
      await app.inject({ method: 'PATCH', url: `/api/industrial/predictions/${id}`, payload: { status: 'WITHDRAWN', note: 'superseded' } })

      const audit = await app.inject({ method: 'GET', url: '/api/industrial/audit' })
      const actions = audit.json().items.map((item: { action: string }) => item.action)
      expect(actions).toContain('PREDICTION_PROPOSED')
      expect(actions).toContain('PREDICTION_TESTED')
      expect(actions).toContain('PREDICTION_WITHDRAWN')
      expect(audit.json().chain.valid).toBe(true)
    } finally {
      await app.close()
    }
  })
})
