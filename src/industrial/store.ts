import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  BIOLOGICAL_ENTITY_KINDS,
  CONNECTOR_KINDS,
  CONNECTOR_MODES,
  CONNECTOR_STATUSES,
  DEVIATION_SEVERITIES,
  DEVIATION_STATUSES,
  GENEALOGY_NODE_TYPES,
  GENEALOGY_RELATIONSHIPS,
  INDUSTRIAL_BATCH_MODES,
  INDUSTRIAL_BATCH_STATUSES,
  INDUSTRIAL_RISKS,
  MATERIAL_LOT_KINDS,
  PARAMETER_CLASSIFICATIONS,
  TELEMETRY_QUALITIES,
  type BiologicalEntity,
  type BiologicalEntityKind,
  type ConnectorKind,
  type ConnectorMode,
  type ConnectorStatus,
  type Deviation,
  type DeviationSeverity,
  type DeviationStatus,
  type GenealogyLink,
  type GenealogyNodeType,
  type GenealogyRelationship,
  type IndustrialActionDecision,
  type IndustrialActionProposal,
  type IndustrialActionStatus,
  type IndustrialActor,
  type IndustrialAuditRecord,
  type IndustrialBatchMode,
  type IndustrialBatchProfile,
  type IndustrialBatchStatus,
  type IndustrialConnector,
  type IndustrialOverview,
  type IndustrialRisk,
  type MaterialLot,
  type ModelPrediction,
  type ModelPredictionStatus,
  type MaterialLotKind,
  type ParameterClassification,
  type ProcessParameter,
  type TelemetryPoint,
  type TelemetryQuality,
} from './types.js'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string => `${prefix}-${crypto.randomUUID().slice(0, 8)}`
const GENESIS_HASH = 'GENESIS'
const MAX_TEXT = 200
const MAX_REASON = 600
const MAX_CAPABILITIES = 24

/** Risk decides how many distinct approvers an industrial action needs. */
const REQUIRED_APPROVALS: Record<IndustrialRisk, number> = { LOW: 1, MEDIUM: 1, HIGH: 2 }

/** A prediction must be tested before it can be confirmed or refuted. */
const PREDICTION_TRANSITIONS: Record<ModelPredictionStatus, Array<Exclude<ModelPredictionStatus, 'PROPOSED'>>> = {
  PROPOSED: ['TESTED', 'WITHDRAWN'],
  TESTED: ['CONFIRMED', 'REFUTED', 'WITHDRAWN'],
  CONFIRMED: [],
  REFUTED: [],
  WITHDRAWN: [],
}

function oneOf<T extends string>(values: readonly T[], value: unknown, field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${field} 必须是 ${values.join('、')} 之一。`)
  }
  return value as T
}

function text(value: unknown, field: string, max = MAX_TEXT, required = true): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} 不能为空。`)
    return ''
  }
  if (typeof value !== 'string') throw new Error(`${field} 必须是文本。`)
  const normalized = value.trim()
  if (required && !normalized) throw new Error(`${field} 不能为空。`)
  if (normalized.length > max) throw new Error(`${field} 长度不能超过 ${max} 个字符。`)
  return normalized
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${field} 必须是数字。`)
  return parsed
}

function number(value: unknown, field: string): number {
  const parsed = optionalNumber(value, field)
  if (parsed === undefined) throw new Error(`${field} 不能为空。`)
  return parsed
}

function optionalIso(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = new Date(String(value))
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} 必须是有效时间。`)
  return parsed.toISOString()
}

function metadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('metadata 必须是对象。')
  return value as Record<string, unknown>
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/**
 * The industrial store is deliberately separate from the workflow database: it
 * keeps production-shaped records (batches, genealogy, telemetry, deviations,
 * connectors and action proposals) and never dispatches anything to an external
 * system. Proposals stop at an approval boundary.
 */
export class IndustrialStore {
  private readonly db: DatabaseSync
  private transactionDepth = 0

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  // ---------------------------------------------------------------- batch profile

  profile(workflowRunId: string): IndustrialBatchProfile | undefined {
    const row = this.db.prepare('SELECT * FROM industrial_batches WHERE workflow_run_id = ?')
      .get(workflowRunId) as unknown as BatchRow | undefined
    return row ? profileFrom(row) : undefined
  }

  saveProfile(workflowRunId: string, input: BatchProfileInput, actor: IndustrialActor): IndustrialBatchProfile {
    const existing = this.profile(workflowRunId)
    const createdAt = existing?.createdAt ?? now()
    const profile: IndustrialBatchProfile = {
      workflowRunId,
      batchNumber: text(input.batchNumber, '批次号'),
      productName: text(input.productName, '产品名称'),
      facility: text(input.facility ?? '', '厂区', MAX_TEXT, false),
      area: text(input.area ?? '', '车间', MAX_TEXT, false),
      processCell: text(input.processCell ?? '', '工艺单元', MAX_TEXT, false),
      unit: text(input.unit ?? '', '单元', MAX_TEXT, false),
      recipeId: text(input.recipeId ?? '', '配方 ID', MAX_TEXT, false),
      recipeVersion: text(input.recipeVersion ?? '', '配方版本', MAX_TEXT, false),
      mode: oneOf(INDUSTRIAL_BATCH_MODES, input.mode ?? 'SHADOW', '批次模式'),
      status: oneOf(INDUSTRIAL_BATCH_STATUSES, input.status ?? 'PLANNED', '批次状态'),
      createdAt,
      updatedAt: now(),
    }
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO industrial_batches (
          workflow_run_id, batch_number, product_name, facility, area, process_cell, unit,
          recipe_id, recipe_version, mode, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workflow_run_id) DO UPDATE SET
          batch_number = excluded.batch_number, product_name = excluded.product_name,
          facility = excluded.facility, area = excluded.area, process_cell = excluded.process_cell,
          unit = excluded.unit, recipe_id = excluded.recipe_id, recipe_version = excluded.recipe_version,
          mode = excluded.mode, status = excluded.status, updated_at = excluded.updated_at
      `).run(
        profile.workflowRunId, profile.batchNumber, profile.productName, profile.facility, profile.area,
        profile.processCell, profile.unit, profile.recipeId, profile.recipeVersion, profile.mode,
        profile.status, profile.createdAt, profile.updatedAt,
      )
      this.appendAudit(workflowRunId, actor, existing ? 'BATCH_PROFILE_UPDATED' : 'BATCH_PROFILE_CREATED',
        'batch', workflowRunId, text(input.reason ?? '', '原因', MAX_REASON, false),
        existing ?? null, profile)
      return profile
    })
  }

  // ------------------------------------------------------------ biological entity

  entities(workflowRunId: string): BiologicalEntity[] {
    const rows = this.db.prepare('SELECT * FROM biological_entities WHERE workflow_run_id = ? ORDER BY created_at DESC')
      .all(workflowRunId) as unknown as EntityRow[]
    return rows.map(entityFrom)
  }

  addEntity(workflowRunId: string, input: EntityInput, actor: IndustrialActor): BiologicalEntity {
    const entity: BiologicalEntity = {
      id: id('entity'),
      workflowRunId,
      kind: oneOf(BIOLOGICAL_ENTITY_KINDS, input.kind, '生物实体类型'),
      name: text(input.name, '名称'),
      externalId: text(input.externalId ?? '', '外部 ID', MAX_TEXT, false),
      version: text(input.version ?? '', '版本', MAX_TEXT, false),
      metadata: metadata(input.metadata),
      createdAt: now(),
    }
    if (input.parentId) {
      const parentId = text(input.parentId, '父实体 ID')
      this.requireEntity(workflowRunId, parentId)
      entity.parentId = parentId
    }
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO biological_entities (
          id, workflow_run_id, kind, name, external_id, version, parent_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entity.id, entity.workflowRunId, entity.kind, entity.name, entity.externalId, entity.version,
        entity.parentId ?? null, JSON.stringify(entity.metadata), entity.createdAt,
      )
      this.appendAudit(workflowRunId, actor, 'BIOLOGICAL_ENTITY_RECORDED', 'biological_entity', entity.id,
        text(input.reason ?? '', '原因', MAX_REASON, false), null, entity)
      return entity
    })
  }

  // ----------------------------------------------------------------- material lot

  lots(workflowRunId: string): MaterialLot[] {
    const rows = this.db.prepare('SELECT * FROM material_lots WHERE workflow_run_id = ? ORDER BY created_at DESC')
      .all(workflowRunId) as unknown as LotRow[]
    return rows.map(lotFrom)
  }

  addLot(workflowRunId: string, input: LotInput, actor: IndustrialActor): MaterialLot {
    const lot: MaterialLot = {
      id: id('lot'),
      workflowRunId,
      kind: oneOf(MATERIAL_LOT_KINDS, input.kind, '物料类型'),
      name: text(input.name, '名称'),
      lotNumber: text(input.lotNumber, '批号'),
      supplier: text(input.supplier ?? '', '供应商', MAX_TEXT, false),
      unit: text(input.unit ?? '', '单位', 40, false),
      metadata: metadata(input.metadata),
      createdAt: now(),
    }
    const quantity = optionalNumber(input.quantity, '数量')
    if (quantity !== undefined) lot.quantity = quantity
    const expiresAt = optionalIso(input.expiresAt, '有效期')
    if (expiresAt) lot.expiresAt = expiresAt
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO material_lots (
          id, workflow_run_id, kind, name, lot_number, supplier, quantity, unit, expires_at, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lot.id, lot.workflowRunId, lot.kind, lot.name, lot.lotNumber, lot.supplier, lot.quantity ?? null,
        lot.unit, lot.expiresAt ?? null, JSON.stringify(lot.metadata), lot.createdAt,
      )
      this.appendAudit(workflowRunId, actor, 'MATERIAL_LOT_RECORDED', 'material_lot', lot.id,
        text(input.reason ?? '', '原因', MAX_REASON, false), null, lot)
      return lot
    })
  }

  // -------------------------------------------------------------------- genealogy

  genealogy(workflowRunId: string): GenealogyLink[] {
    const rows = this.db.prepare('SELECT * FROM genealogy_links WHERE workflow_run_id = ? ORDER BY created_at DESC')
      .all(workflowRunId) as unknown as GenealogyRow[]
    return rows.map(genealogyFrom)
  }

  addGenealogyLink(workflowRunId: string, input: GenealogyInput, actor: IndustrialActor): GenealogyLink {
    const sourceType = oneOf(GENEALOGY_NODE_TYPES, input.sourceType, '来源节点类型')
    const targetType = oneOf(GENEALOGY_NODE_TYPES, input.targetType, '目标节点类型')
    const sourceId = text(input.sourceId, '来源节点 ID')
    const targetId = text(input.targetId, '目标节点 ID')
    this.requireNode(workflowRunId, sourceType, sourceId)
    this.requireNode(workflowRunId, targetType, targetId)
    const link: GenealogyLink = {
      id: id('link'),
      workflowRunId,
      sourceType,
      sourceId,
      targetType,
      targetId,
      relationship: oneOf(GENEALOGY_RELATIONSHIPS, input.relationship, '关系'),
      unit: text(input.unit ?? '', '单位', 40, false),
      createdAt: now(),
    }
    const quantity = optionalNumber(input.quantity, '数量')
    if (quantity !== undefined) link.quantity = quantity
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO genealogy_links (
          id, workflow_run_id, source_type, source_id, target_type, target_id, relationship, quantity, unit, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        link.id, link.workflowRunId, link.sourceType, link.sourceId, link.targetType, link.targetId,
        link.relationship, link.quantity ?? null, link.unit, link.createdAt,
      )
      this.appendAudit(workflowRunId, actor, 'GENEALOGY_LINK_RECORDED', 'genealogy_link', link.id,
        text(input.reason ?? '', '原因', MAX_REASON, false), null, link)
      return link
    })
  }

  // ------------------------------------------------------------------ parameters

  parameters(workflowRunId: string): ProcessParameter[] {
    const rows = this.db.prepare('SELECT * FROM process_parameters WHERE workflow_run_id = ? ORDER BY key')
      .all(workflowRunId) as unknown as ParameterRow[]
    return rows.map(parameterFrom)
  }

  saveParameter(workflowRunId: string, input: ParameterInput, actor: IndustrialActor): ProcessParameter {
    const key = text(input.key, '参数键', 80)
    const existing = this.parameter(workflowRunId, key)
    const lowerLimit = optionalNumber(input.lowerLimit, '下限')
    const upperLimit = optionalNumber(input.upperLimit, '上限')
    if (lowerLimit !== undefined && upperLimit !== undefined && lowerLimit > upperLimit) {
      throw new Error('参数下限不能大于上限。')
    }
    const parameter: ProcessParameter = {
      workflowRunId,
      key,
      name: text(input.name ?? key, '参数名称'),
      classification: oneOf(PARAMETER_CLASSIFICATIONS, input.classification ?? 'PROCESS', '参数分类'),
      unit: text(input.unit ?? '', '单位', 40, false),
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    }
    const target = optionalNumber(input.target, '目标值')
    if (target !== undefined) parameter.target = target
    if (lowerLimit !== undefined) parameter.lowerLimit = lowerLimit
    if (upperLimit !== undefined) parameter.upperLimit = upperLimit
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO process_parameters (
          workflow_run_id, key, name, classification, unit, target, lower_limit, upper_limit, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workflow_run_id, key) DO UPDATE SET
          name = excluded.name, classification = excluded.classification, unit = excluded.unit,
          target = excluded.target, lower_limit = excluded.lower_limit, upper_limit = excluded.upper_limit,
          updated_at = excluded.updated_at
      `).run(
        parameter.workflowRunId, parameter.key, parameter.name, parameter.classification, parameter.unit,
        parameter.target ?? null, parameter.lowerLimit ?? null, parameter.upperLimit ?? null,
        parameter.createdAt, parameter.updatedAt,
      )
      this.appendAudit(workflowRunId, actor, existing ? 'PROCESS_PARAMETER_UPDATED' : 'PROCESS_PARAMETER_DEFINED',
        'process_parameter', key, text(input.reason ?? '', '原因', MAX_REASON, false), existing ?? null, parameter)
      return parameter
    })
  }

  parameter(workflowRunId: string, key: string): ProcessParameter | undefined {
    const row = this.db.prepare('SELECT * FROM process_parameters WHERE workflow_run_id = ? AND key = ?')
      .get(workflowRunId, key) as unknown as ParameterRow | undefined
    return row ? parameterFrom(row) : undefined
  }

  // -------------------------------------------------------------------- telemetry

  telemetry(workflowRunId: string, limit = 50): TelemetryPoint[] {
    const rows = this.db.prepare(`
      SELECT * FROM telemetry_points WHERE workflow_run_id = ? ORDER BY received_at DESC LIMIT ?
    `).all(workflowRunId, Math.max(1, Math.min(limit, 500))) as unknown as TelemetryRow[]
    return rows.map(telemetryFrom)
  }

  /**
   * Records one measurement. A value outside the parameter limits opens an
   * automatic deviation instead of silently keeping the reading.
   */
  recordTelemetry(workflowRunId: string, input: TelemetryInput, actor: IndustrialActor): TelemetryResult {
    const parameterKey = text(input.parameterKey, '参数键', 80)
    const value = number(input.value, '测量值')
    const parameter = this.parameter(workflowRunId, parameterKey)
    const point: TelemetryPoint = {
      id: id('telemetry'),
      workflowRunId,
      parameterKey,
      value,
      unit: text(input.unit ?? parameter?.unit ?? '', '单位', 40, false),
      quality: oneOf(TELEMETRY_QUALITIES, input.quality ?? 'GOOD', '数据质量'),
      recordedAt: optionalIso(input.recordedAt, '记录时间') ?? now(),
      receivedAt: now(),
    }
    if (input.connectorId) {
      const connectorId = text(input.connectorId, '连接器 ID')
      this.requireConnector(workflowRunId, connectorId)
      point.connectorId = connectorId
    }
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO telemetry_points (
          id, workflow_run_id, parameter_key, value, unit, quality, connector_id, recorded_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        point.id, point.workflowRunId, point.parameterKey, point.value, point.unit, point.quality,
        point.connectorId ?? null, point.recordedAt, point.receivedAt,
      )
      this.appendAudit(workflowRunId, actor, 'TELEMETRY_RECORDED', 'telemetry_point', point.id,
        text(input.reason ?? '', '原因', MAX_REASON, false), null, point)
      const deviation = this.evaluateLimits(workflowRunId, point, parameter, actor)
      return deviation ? { point, deviation } : { point }
    })
  }

  private evaluateLimits(
    workflowRunId: string,
    point: TelemetryPoint,
    parameter: ProcessParameter | undefined,
    actor: IndustrialActor,
  ): Deviation | undefined {
    if (!parameter) return undefined
    const below = parameter.lowerLimit !== undefined && point.value < parameter.lowerLimit
    const above = parameter.upperLimit !== undefined && point.value > parameter.upperLimit
    if (!below && !above) return undefined
    const severity: DeviationSeverity = parameter.classification === 'CPP' ? 'HIGH' : 'MEDIUM'
    const open = (this.db.prepare(`
      SELECT * FROM deviations
      WHERE workflow_run_id = ? AND parameter_key = ? AND source = 'AUTO_LIMIT' AND status = 'OPEN'
      ORDER BY opened_at DESC LIMIT 1
    `).get(workflowRunId, point.parameterKey) as unknown as DeviationRow | undefined)
    const limits = { lowerLimit: parameter.lowerLimit, upperLimit: parameter.upperLimit }
    if (open) {
      const updated: Deviation = {
        ...deviationFrom(open),
        observedValue: point.value,
        severity,
        updatedAt: now(),
      }
      this.db.prepare('UPDATE deviations SET observed_value = ?, severity = ?, updated_at = ? WHERE id = ?')
        .run(point.value, severity, updated.updatedAt, updated.id)
      this.appendAudit(workflowRunId, actor, 'DEVIATION_UPDATED', 'deviation', updated.id,
        '重复越界，更新观测值', deviationFrom(open), updated)
      return updated
    }
    const deviation: Deviation = {
      id: id('deviation'),
      workflowRunId,
      code: `AUTO-${point.parameterKey}`.slice(0, 60),
      title: `参数越界：${parameter.name}`,
      description: `${parameter.name} 测得 ${point.value}${point.unit}，超出 ${below ? '下限' : '上限'}。`,
      severity,
      status: 'OPEN',
      source: 'AUTO_LIMIT',
      parameterKey: point.parameterKey,
      observedValue: point.value,
      openedAt: now(),
      updatedAt: now(),
    }
    if (limits.lowerLimit !== undefined) deviation.lowerLimit = limits.lowerLimit
    if (limits.upperLimit !== undefined) deviation.upperLimit = limits.upperLimit
    this.db.prepare(`
      INSERT INTO deviations (
        id, workflow_run_id, code, title, description, severity, status, source, parameter_key,
        observed_value, lower_limit, upper_limit, resolution, opened_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deviation.id, deviation.workflowRunId, deviation.code, deviation.title, deviation.description,
      deviation.severity, deviation.status, deviation.source, deviation.parameterKey ?? null,
      deviation.observedValue ?? null, deviation.lowerLimit ?? null, deviation.upperLimit ?? null,
      null, deviation.openedAt, deviation.updatedAt, null,
    )
    this.appendAudit(workflowRunId, actor, 'DEVIATION_OPENED', 'deviation', deviation.id,
      '测量值越界自动开偏差', null, deviation)
    return deviation
  }

  // ------------------------------------------------------------------- deviations

  deviations(workflowRunId: string, status?: DeviationStatus): Deviation[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM deviations WHERE workflow_run_id = ? AND status = ? ORDER BY opened_at DESC')
        .all(workflowRunId, status) as unknown as DeviationRow[]
      : this.db.prepare('SELECT * FROM deviations WHERE workflow_run_id = ? ORDER BY opened_at DESC')
        .all(workflowRunId) as unknown as DeviationRow[]
    return rows.map(deviationFrom)
  }

  addDeviation(workflowRunId: string, input: DeviationInput, actor: IndustrialActor): Deviation {
    const deviation: Deviation = {
      id: id('deviation'),
      workflowRunId,
      code: text(input.code ?? `MAN-${Date.now().toString(36)}`.toUpperCase(), '偏差编号', 60),
      title: text(input.title, '偏差标题'),
      description: text(input.description ?? '', '偏差描述', 2_000, false),
      severity: oneOf(DEVIATION_SEVERITIES, input.severity ?? 'LOW', '偏差严重度'),
      status: 'OPEN',
      source: 'MANUAL',
      openedAt: now(),
      updatedAt: now(),
    }
    if (input.parameterKey) {
      const parameterKey = text(input.parameterKey, '参数键', 80)
      this.parameter(workflowRunId, parameterKey)
      deviation.parameterKey = parameterKey
    }
    const observedValue = optionalNumber(input.observedValue, '观测值')
    if (observedValue !== undefined) deviation.observedValue = observedValue
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO deviations (
          id, workflow_run_id, code, title, description, severity, status, source, parameter_key,
          observed_value, lower_limit, upper_limit, resolution, opened_at, updated_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deviation.id, deviation.workflowRunId, deviation.code, deviation.title, deviation.description,
        deviation.severity, deviation.status, deviation.source, deviation.parameterKey ?? null,
        deviation.observedValue ?? null, null, null, null, deviation.openedAt, deviation.updatedAt, null,
      )
      this.appendAudit(workflowRunId, actor, 'DEVIATION_OPENED', 'deviation', deviation.id,
        text(input.reason ?? '', '原因', MAX_REASON, false), null, deviation)
      return deviation
    })
  }

  resolveDeviation(deviationId: string, input: DeviationResolutionInput, actor: IndustrialActor): Deviation {
    const row = this.db.prepare('SELECT * FROM deviations WHERE id = ?').get(deviationId) as unknown as DeviationRow | undefined
    if (!row) throw new Error('偏差不存在。')
    const existing = deviationFrom(row)
    if (existing.status === 'CLOSED') throw new Error('已关闭的偏差不能再次变更。')
    const status = oneOf(DEVIATION_STATUSES, input.status, '偏差状态')
    if (status === 'OPEN') throw new Error('不能把偏差改回 OPEN。')
    const updated: Deviation = {
      ...existing,
      status,
      updatedAt: now(),
    }
    const resolution = text(input.resolution ?? '', '处理说明', 2_000, false)
    if (resolution) updated.resolution = resolution
    if (status === 'RESOLVED' || status === 'CLOSED') updated.resolvedAt = updated.updatedAt
    return this.transaction(() => {
      this.db.prepare('UPDATE deviations SET status = ?, resolution = ?, updated_at = ?, resolved_at = ? WHERE id = ?')
        .run(updated.status, updated.resolution ?? null, updated.updatedAt, updated.resolvedAt ?? null, updated.id)
      this.appendAudit(existing.workflowRunId, actor, 'DEVIATION_UPDATED', 'deviation', updated.id,
        text(input.reason ?? '', '原因', MAX_REASON, false), existing, updated)
      return updated
    })
  }

  // ------------------------------------------------------------------- connectors

  connectors(workflowRunId: string): IndustrialConnector[] {
    const rows = this.db.prepare('SELECT * FROM connectors WHERE workflow_run_id = ? ORDER BY created_at')
      .all(workflowRunId) as unknown as ConnectorRow[]
    return rows.map(connectorFrom)
  }

  saveConnector(workflowRunId: string, input: ConnectorInput, actor: IndustrialActor): IndustrialConnector {
    const existing = input.id ? this.connector(input.id) : undefined
    if (input.id && !existing) throw new Error('连接器不存在。')
    const capabilities = input.capabilities === undefined
      ? existing?.capabilities ?? []
      : normaliseCapabilities(input.capabilities)
    const connector: IndustrialConnector = {
      id: existing?.id ?? id('connector'),
      workflowRunId,
      name: text(input.name, '连接器名称'),
      kind: oneOf(CONNECTOR_KINDS, input.kind, '连接器类型'),
      mode: oneOf(CONNECTOR_MODES, input.mode ?? existing?.mode ?? 'READ_ONLY', '连接器模式'),
      status: oneOf(CONNECTOR_STATUSES, input.status ?? existing?.status ?? 'OFFLINE', '连接器状态'),
      endpoint: text(input.endpoint ?? '', '接入地址', 500, false),
      credentialRef: text(input.credentialRef ?? '', '凭据引用', MAX_TEXT, false),
      capabilities,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    }
    const lastSeenAt = optionalIso(input.lastSeenAt, '最后在线时间')
    if (lastSeenAt) connector.lastSeenAt = lastSeenAt
    const statusMessage = text(input.statusMessage ?? '', '状态说明', MAX_REASON, false)
    if (statusMessage) connector.statusMessage = statusMessage
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO connectors (
          id, workflow_run_id, name, kind, mode, status, endpoint, credential_ref, capabilities_json,
          last_seen_at, status_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, kind = excluded.kind, mode = excluded.mode, status = excluded.status,
          endpoint = excluded.endpoint, credential_ref = excluded.credential_ref,
          capabilities_json = excluded.capabilities_json, last_seen_at = excluded.last_seen_at,
          status_message = excluded.status_message, updated_at = excluded.updated_at
      `).run(
        connector.id, connector.workflowRunId, connector.name, connector.kind, connector.mode,
        connector.status, connector.endpoint, connector.credentialRef, JSON.stringify(connector.capabilities),
        connector.lastSeenAt ?? null, connector.statusMessage ?? null, connector.createdAt, connector.updatedAt,
      )
      this.appendAudit(workflowRunId, actor, existing ? 'CONNECTOR_UPDATED' : 'CONNECTOR_REGISTERED',
        'connector', connector.id, text(input.reason ?? '', '原因', MAX_REASON, false), existing ?? null, connector)
      return connector
    })
  }

  connector(connectorId: string): IndustrialConnector | undefined {
    const row = this.db.prepare('SELECT * FROM connectors WHERE id = ?').get(connectorId) as unknown as ConnectorRow | undefined
    return row ? connectorFrom(row) : undefined
  }

  // -------------------------------------------------------------- action proposals

  actions(workflowRunId: string): IndustrialActionProposal[] {
    const rows = this.db.prepare('SELECT * FROM action_proposals WHERE workflow_run_id = ? ORDER BY created_at DESC')
      .all(workflowRunId) as unknown as ActionRow[]
    return rows.map(row => this.actionFrom(row))
  }

  action(actionId: string): IndustrialActionProposal | undefined {
    const row = this.db.prepare('SELECT * FROM action_proposals WHERE id = ?').get(actionId) as unknown as ActionRow | undefined
    return row ? this.actionFrom(row) : undefined
  }

  // ------------------------------------------------------------- model predictions

  predictions(workflowRunId: string): ModelPrediction[] {
    const rows = this.db.prepare('SELECT * FROM model_predictions WHERE workflow_run_id = ? ORDER BY created_at DESC')
      .all(workflowRunId) as unknown as PredictionRow[]
    return rows.map(predictionFrom)
  }

  prediction(predictionId: string): ModelPrediction | undefined {
    const row = this.db.prepare('SELECT * FROM model_predictions WHERE id = ?')
      .get(predictionId) as unknown as PredictionRow | undefined
    return row ? predictionFrom(row) : undefined
  }

  /**
   * Existing prediction for a workflow run and a job-derived artifact reference.
   * This is a narrow, persisted idempotency key: if a modeling task update failed
   * after the prediction row was written, a retry (even after restart) resolves
   * the same record instead of creating a duplicate.
   */
  predictionByArtifact(workflowRunId: string, artifactRef: string): ModelPrediction | undefined {
    const reference = artifactRef.trim()
    if (!workflowRunId.trim() || !reference) return undefined
    const row = this.db.prepare(`SELECT * FROM model_predictions
      WHERE workflow_run_id = ? AND artifact_ref = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(workflowRunId, reference) as unknown as PredictionRow | undefined
    return row ? predictionFrom(row) : undefined
  }

  /**
   * Records what a model predicted, before any experiment tested it. Confirmation
   * or refutation always requires the prediction to be marked TESTED first, so a
   * prediction cannot be reported as validated without an experiment.
   */
  addPrediction(workflowRunId: string, input: PredictionInput, actor: IndustrialActor): ModelPrediction {
    const prediction: ModelPrediction = {
      id: id('prediction'),
      workflowRunId,
      model: text(input.model, '模型/方法名', 500),
      artifactRef: text(input.artifactRef ?? '', '证据引用', 500, false),
      prediction: text(input.prediction, '预测内容', 2_000),
      conditions: text(input.conditions ?? '', '适用条件', 500, false),
      uncertainty: text(input.uncertainty ?? '', '不确定性说明', 500, false),
      status: 'PROPOSED',
      linkedExperiment: text(input.linkedExperiment ?? '', '关联实验', 500, false),
      createdAt: now(),
      updatedAt: now(),
    }
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO model_predictions (
          id, workflow_run_id, model, artifact_ref, prediction, conditions, uncertainty, status,
          linked_experiment, resolution_note, created_at, updated_at, tested_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        prediction.id, prediction.workflowRunId, prediction.model, prediction.artifactRef, prediction.prediction,
        prediction.conditions, prediction.uncertainty, prediction.status, prediction.linkedExperiment, null,
        prediction.createdAt, prediction.updatedAt, null, null,
      )
      this.appendAudit(workflowRunId, actor, 'PREDICTION_PROPOSED', 'model_prediction', prediction.id,
        text(input.reason ?? '', '原因', MAX_REASON, false), null, prediction)
      return prediction
    })
  }

  /** Attach an experiment reference without changing the prediction's evidence status. */
  linkPredictionExperiment(predictionId: string, experimentRef: string, note: string, actor: IndustrialActor): ModelPrediction {
    const existing = this.prediction(predictionId)
    if (!existing) throw new Error('预测不存在。')
    const linkedExperiment = text(experimentRef, '实验引用', 500)
    const updated: ModelPrediction = { ...existing, linkedExperiment, updatedAt: now() }
    this.db.prepare('UPDATE model_predictions SET linked_experiment = ?, updated_at = ? WHERE id = ?')
      .run(linkedExperiment, updated.updatedAt, predictionId)
    this.appendAudit(existing.workflowRunId, actor, 'PREDICTION_EXPERIMENT_LINKED', 'model_prediction', predictionId,
      text(note, '说明', MAX_REASON, false), existing, updated)
    return updated
  }

  updatePredictionStatus(
    predictionId: string,
    status: Exclude<ModelPredictionStatus, 'PROPOSED'>,
    note: string,
    actor: IndustrialActor,
  ): ModelPrediction {
    const existing = this.prediction(predictionId)
    if (!existing) throw new Error('预测不存在。')
    const allowed = PREDICTION_TRANSITIONS[existing.status]
    if (!allowed.includes(status)) {
      if (existing.status === 'PROPOSED' && (status === 'CONFIRMED' || status === 'REFUTED')) {
        throw new Error('预测必须先标记为 TESTED 才能确认或推翻。')
      }
      if (allowed.length === 0) throw new Error('已结束的预测不能再次变更。')
      throw new Error(`不允许的预测状态变更：${existing.status} → ${status}。`)
    }
    const updated: ModelPrediction = {
      ...existing,
      status,
      updatedAt: now(),
    }
    const resolution = text(note, '说明', MAX_REASON, false)
    if (resolution) updated.resolutionNote = resolution
    if (status === 'TESTED') updated.testedAt = updated.updatedAt
    if (status !== 'TESTED') updated.resolvedAt = updated.updatedAt
    const action = `PREDICTION_${status}` as const
    return this.transaction(() => {
      this.db.prepare(`
        UPDATE model_predictions SET status = ?, resolution_note = ?, updated_at = ?, tested_at = ?, resolved_at = ?
        WHERE id = ?
      `).run(updated.status, updated.resolutionNote ?? null, updated.updatedAt,
        updated.testedAt ?? null, updated.resolvedAt ?? null, updated.id)
      this.appendAudit(existing.workflowRunId, actor, action, 'model_prediction', updated.id,
        resolution, existing, updated)
      return updated
    })
  }

  /**
   * Proposes an industrial action. The proposal is recorded and held at an
   * approval boundary: nothing is dispatched to the connector.
   */
  proposeAction(workflowRunId: string, input: ActionInput, actor: IndustrialActor): IndustrialActionProposal {
    const connectorId = text(input.connectorId, '连接器 ID')
    const connector = this.requireConnector(workflowRunId, connectorId)
    if (connector.mode === 'READ_ONLY') {
      throw new Error('该连接器处于 READ_ONLY 模式，不能发起操作提案。')
    }
    if (connector.status === 'OFFLINE' || connector.status === 'ERROR') {
      throw new Error('连接器当前离线或故障，不能发起操作提案。')
    }
    const risk = oneOf(INDUSTRIAL_RISKS, input.risk ?? 'LOW', '风险等级')
    const proposal: IndustrialActionProposal = {
      id: id('action'),
      workflowRunId,
      connectorId,
      operation: text(input.operation, '操作名称', 120),
      payload: metadata(input.payload),
      reason: text(input.reason ?? '', '原因', MAX_REASON, false),
      risk,
      status: 'PENDING',
      requiredApprovals: REQUIRED_APPROVALS[risk],
      createdBy: actor.id,
      createdAt: now(),
      decisions: [],
      dispatchPermitted: false,
    }
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO action_proposals (
          id, workflow_run_id, connector_id, operation, payload_json, reason, risk, status,
          required_approvals, created_by, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        proposal.id, proposal.workflowRunId, proposal.connectorId, proposal.operation,
        JSON.stringify(proposal.payload), proposal.reason, proposal.risk, proposal.status,
        proposal.requiredApprovals, proposal.createdBy, proposal.createdAt, null,
      )
      this.appendAudit(workflowRunId, actor, 'ACTION_PROPOSED', 'action_proposal', proposal.id,
        proposal.reason, null, proposal)
      return proposal
    })
  }

  /** Records one approval or rejection. Approvals never hand over execution. */
  decideAction(actionId: string, decision: 'APPROVE' | 'REJECT', comment: string, actor: IndustrialActor): IndustrialActionProposal {
    const existing = this.action(actionId)
    if (!existing) throw new Error('操作提案不存在。')
    if (existing.status !== 'PENDING') throw new Error('该操作提案已经结束，不能重复审批。')
    if (existing.decisions.some(item => item.actorId === actor.id)) {
      throw new Error('同一操作人不能对同一提案重复表决。')
    }
    const record: IndustrialActionDecision = {
      id: id('decision'),
      actionId,
      actorId: actor.id,
      actorRole: actor.role,
      decision,
      comment: text(comment, '审批意见', MAX_REASON, false),
      createdAt: now(),
    }
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO action_decisions (id, action_id, actor_id, actor_role, decision, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, record.actionId, record.actorId, record.actorRole, record.decision, record.comment, record.createdAt)
      const decisions = [...existing.decisions, record]
      const approvals = new Set(decisions.filter(item => item.decision === 'APPROVE').map(item => item.actorId))
      const rejected = decisions.some(item => item.decision === 'REJECT')
      let status: IndustrialActionStatus = 'PENDING'
      let resolvedAt: string | undefined
      if (rejected) {
        status = 'REJECTED'
        resolvedAt = record.createdAt
      } else if (approvals.size >= existing.requiredApprovals) {
        status = 'APPROVED'
        resolvedAt = record.createdAt
      }
      this.db.prepare('UPDATE action_proposals SET status = ?, resolved_at = ? WHERE id = ?')
        .run(status, resolvedAt ?? null, actionId)
      const updated = this.action(actionId)
      if (!updated) throw new Error('操作提案不存在。')
      this.appendAudit(existing.workflowRunId, actor, `ACTION_${decision}_RECORDED`, 'action_proposal', actionId,
        record.comment, existing, updated)
      return updated
    })
  }

  private actionFrom(row: ActionRow): IndustrialActionProposal {
    const decisions = this.db.prepare('SELECT * FROM action_decisions WHERE action_id = ? ORDER BY created_at')
      .all(row.id) as unknown as DecisionRow[]
    const proposal: IndustrialActionProposal = {
      id: row.id,
      workflowRunId: row.workflow_run_id,
      connectorId: row.connector_id,
      operation: row.operation,
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
      reason: row.reason,
      risk: row.risk as IndustrialRisk,
      status: row.status as IndustrialActionStatus,
      requiredApprovals: row.required_approvals,
      createdBy: row.created_by,
      createdAt: row.created_at,
      decisions: decisions.map(decisionFrom),
      dispatchPermitted: false,
    }
    if (row.resolved_at) proposal.resolvedAt = row.resolved_at
    return proposal
  }

  // ------------------------------------------------------------------------ audit

  audit(options: { workflowRunId?: string; limit?: number } = {}): IndustrialAuditRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500))
    const rows = options.workflowRunId
      ? this.db.prepare('SELECT * FROM industrial_audit WHERE workflow_run_id = ? ORDER BY sequence DESC LIMIT ?')
        .all(options.workflowRunId, limit) as unknown as AuditRow[]
      : this.db.prepare('SELECT * FROM industrial_audit ORDER BY created_at DESC LIMIT ?')
        .all(limit) as unknown as AuditRow[]
    return rows.map(auditFrom)
  }

  /** Recomputes the hash chain so tampering with stored rows becomes visible. */
  auditChain(workflowRunId: string): { valid: boolean; records: number; headHash: string } {
    const rows = this.db.prepare('SELECT * FROM industrial_audit WHERE workflow_run_id = ? ORDER BY sequence')
      .all(workflowRunId) as unknown as AuditRow[]
    let previousHash = GENESIS_HASH
    let valid = true
    for (const row of rows) {
      const expected = hashRecord(previousHash, {
        sequence: row.sequence,
        id: row.id,
        workflowRunId: row.workflow_run_id,
        actorId: row.actor_id,
        actorRole: row.actor_role,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        reason: row.reason,
        before: parseJson<unknown>(row.before_json, null),
        after: parseJson<unknown>(row.after_json, null),
        createdAt: row.created_at,
      })
      if (row.previous_hash !== previousHash || row.record_hash !== expected) valid = false
      previousHash = row.record_hash
    }
    return { valid, records: rows.length, headHash: rows.length ? previousHash : GENESIS_HASH }
  }

  // --------------------------------------------------------------------- overview

  overview(workflowRunId: string): IndustrialOverview {
    const profile = this.profile(workflowRunId)
    const telemetry = this.telemetry(workflowRunId, 200)
    const latest = new Map<string, TelemetryPoint>()
    for (const point of telemetry) {
      if (!latest.has(point.parameterKey)) latest.set(point.parameterKey, point)
    }
    const chain = this.auditChain(workflowRunId)
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE workflow_run_id = ?`)
        .get(workflowRunId) as { total: number }
      return row.total
    }
    const pending = this.db.prepare(`
      SELECT COUNT(*) AS total FROM action_proposals WHERE workflow_run_id = ? AND status = 'PENDING'
    `).get(workflowRunId) as { total: number }
    const pendingPredictions = this.db.prepare(`
      SELECT COUNT(*) AS total FROM model_predictions WHERE workflow_run_id = ? AND status IN ('PROPOSED', 'TESTED')
    `).get(workflowRunId) as { total: number }
    const result: IndustrialOverview = {
      connectors: this.connectors(workflowRunId),
      latestTelemetry: [...latest.values()],
      openDeviations: this.deviations(workflowRunId, 'OPEN'),
      counts: {
        biologicalEntities: count('biological_entities'),
        materialLots: count('material_lots'),
        genealogyLinks: count('genealogy_links'),
        parameters: count('process_parameters'),
        telemetryPoints: count('telemetry_points'),
        pendingActions: pending.total,
        pendingPredictions: pendingPredictions.total,
      },
      executionPolicy: {
        phase: 'SHADOW',
        writesEnabled: false,
        identityMode: 'development-header',
        message: '当前为影子阶段：只读取与提案，不向任何生产系统写入。',
      },
      audit: { valid: chain.valid, records: chain.records, headHash: chain.headHash },
    }
    if (profile) result.profile = profile
    return result
  }

  // ---------------------------------------------------------------------- internals

  private requireEntity(workflowRunId: string, entityId: string): BiologicalEntity {
    const entity = this.entities(workflowRunId).find(item => item.id === entityId)
    if (!entity) throw new Error('父生物实体不存在。')
    return entity
  }

  private requireConnector(workflowRunId: string, connectorId: string): IndustrialConnector {
    const connector = this.connectors(workflowRunId).find(item => item.id === connectorId)
    if (!connector) throw new Error('连接器不存在。')
    return connector
  }

  private requireNode(workflowRunId: string, type: GenealogyNodeType, nodeId: string): void {
    const exists = type === 'BATCH'
      ? Boolean(this.profile(workflowRunId) && workflowRunId === nodeId)
      : type === 'BIOLOGICAL_ENTITY'
        ? this.entities(workflowRunId).some(item => item.id === nodeId)
        : this.lots(workflowRunId).some(item => item.id === nodeId)
    if (!exists) throw new Error(`谱系节点不存在：${type} ${nodeId}`)
  }

  private appendAudit(
    workflowRunId: string,
    actor: IndustrialActor,
    action: string,
    entityType: string,
    entityId: string,
    reason: string,
    before: unknown,
    after: unknown,
  ): IndustrialAuditRecord {
    const head = this.db.prepare(`
      SELECT record_hash, sequence FROM industrial_audit WHERE workflow_run_id = ? ORDER BY sequence DESC LIMIT 1
    `).get(workflowRunId) as { record_hash: string; sequence: number } | undefined
    const sequence = (head?.sequence ?? 0) + 1
    const previousHash = head?.record_hash ?? GENESIS_HASH
    const createdAt = now()
    const recordId = id('audit')
    const beforeValue = before === null || before === undefined ? null : before
    const recordHash = hashRecord(previousHash, {
      sequence, id: recordId, workflowRunId, actorId: actor.id, actorRole: actor.role, action,
      entityType, entityId, reason, before: beforeValue, after, createdAt,
    })
    this.db.prepare(`
      INSERT INTO industrial_audit (
        sequence, id, workflow_run_id, actor_id, actor_role, action, entity_type, entity_id,
        reason, before_json, after_json, previous_hash, record_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sequence, recordId, workflowRunId, actor.id, actor.role, action, entityType, entityId,
      reason, JSON.stringify(beforeValue), JSON.stringify(after), previousHash, recordHash, createdAt,
    )
    return {
      sequence,
      id: recordId,
      workflowRunId,
      actorId: actor.id,
      actorRole: actor.role,
      action,
      entityType,
      entityId,
      reason,
      before: beforeValue,
      after,
      previousHash,
      recordHash,
      createdAt,
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth += 1
    try {
      const result = operation()
      this.db.exec('COMMIT')
      this.transactionDepth -= 1
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.transactionDepth -= 1
      throw error
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS industrial_batches (
        workflow_run_id TEXT PRIMARY KEY, batch_number TEXT NOT NULL, product_name TEXT NOT NULL,
        facility TEXT NOT NULL, area TEXT NOT NULL, process_cell TEXT NOT NULL, unit TEXT NOT NULL,
        recipe_id TEXT NOT NULL, recipe_version TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS biological_entities (
        id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        external_id TEXT NOT NULL, version TEXT NOT NULL, parent_id TEXT, metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS material_lots (
        id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        lot_number TEXT NOT NULL, supplier TEXT NOT NULL, quantity REAL, unit TEXT NOT NULL,
        expires_at TEXT, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS genealogy_links (
        id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
        target_type TEXT NOT NULL, target_id TEXT NOT NULL, relationship TEXT NOT NULL, quantity REAL,
        unit TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS process_parameters (
        workflow_run_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, classification TEXT NOT NULL,
        unit TEXT NOT NULL, target REAL, lower_limit REAL, upper_limit REAL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY (workflow_run_id, key)
      );
      CREATE TABLE IF NOT EXISTS telemetry_points (
        id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, parameter_key TEXT NOT NULL, value REAL NOT NULL,
        unit TEXT NOT NULL, quality TEXT NOT NULL, connector_id TEXT, recorded_at TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deviations (
        id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
        parameter_key TEXT, observed_value REAL, lower_limit REAL, upper_limit REAL, resolution TEXT,
        opened_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS connectors (
        id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        mode TEXT NOT NULL, status TEXT NOT NULL, endpoint TEXT NOT NULL, credential_ref TEXT NOT NULL,
        capabilities_json TEXT NOT NULL, last_seen_at TEXT, status_message TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_proposals (
        id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, connector_id TEXT NOT NULL, operation TEXT NOT NULL,
        payload_json TEXT NOT NULL, reason TEXT NOT NULL, risk TEXT NOT NULL, status TEXT NOT NULL,
        required_approvals INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS action_decisions (
        id TEXT PRIMARY KEY, action_id TEXT NOT NULL, actor_id TEXT NOT NULL, actor_role TEXT NOT NULL,
        decision TEXT NOT NULL, comment TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS industrial_audit (
        sequence INTEGER NOT NULL, id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        actor_role TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        reason TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, previous_hash TEXT NOT NULL,
        record_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (workflow_run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_industrial_entities_run ON biological_entities(workflow_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_industrial_lots_run ON material_lots(workflow_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_industrial_links_run ON genealogy_links(workflow_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_industrial_telemetry_run ON telemetry_points(workflow_run_id, received_at);
      CREATE INDEX IF NOT EXISTS idx_industrial_deviations_run ON deviations(workflow_run_id, status, opened_at);
      CREATE INDEX IF NOT EXISTS idx_industrial_actions_run ON action_proposals(workflow_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_industrial_decisions_action ON action_decisions(action_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_industrial_audit_run ON industrial_audit(workflow_run_id, sequence);
      CREATE TABLE IF NOT EXISTS model_predictions (
        id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, model TEXT NOT NULL, artifact_ref TEXT NOT NULL,
        prediction TEXT NOT NULL, conditions TEXT NOT NULL, uncertainty TEXT NOT NULL, status TEXT NOT NULL,
        linked_experiment TEXT NOT NULL, resolution_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        tested_at TEXT, resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_model_predictions_run ON model_predictions(workflow_run_id, created_at);
    `)
  }
}

export function hashRecord(previousHash: string, fields: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({ previousHash, ...fields })).digest('hex')
}

function normaliseCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('capabilities 必须是字符串数组。')
  if (value.length > MAX_CAPABILITIES) throw new Error(`capabilities 最多 ${MAX_CAPABILITIES} 项。`)
  return [...new Set(value.map(item => text(item, 'capability', 80)))]
}

// ------------------------------------------------------------------- row mapping

interface BatchRow {
  workflow_run_id: string
  batch_number: string
  product_name: string
  facility: string
  area: string
  process_cell: string
  unit: string
  recipe_id: string
  recipe_version: string
  mode: string
  status: string
  created_at: string
  updated_at: string
}

interface EntityRow {
  id: string
  workflow_run_id: string
  kind: string
  name: string
  external_id: string
  version: string
  parent_id: string | null
  metadata_json: string
  created_at: string
}

interface LotRow {
  id: string
  workflow_run_id: string
  kind: string
  name: string
  lot_number: string
  supplier: string
  quantity: number | null
  unit: string
  expires_at: string | null
  metadata_json: string
  created_at: string
}

interface GenealogyRow {
  id: string
  workflow_run_id: string
  source_type: string
  source_id: string
  target_type: string
  target_id: string
  relationship: string
  quantity: number | null
  unit: string
  created_at: string
}

interface ParameterRow {
  workflow_run_id: string
  key: string
  name: string
  classification: string
  unit: string
  target: number | null
  lower_limit: number | null
  upper_limit: number | null
  created_at: string
  updated_at: string
}

interface TelemetryRow {
  id: string
  workflow_run_id: string
  parameter_key: string
  value: number
  unit: string
  quality: string
  connector_id: string | null
  recorded_at: string
  received_at: string
}

interface DeviationRow {
  id: string
  workflow_run_id: string
  code: string
  title: string
  description: string
  severity: string
  status: string
  source: string
  parameter_key: string | null
  observed_value: number | null
  lower_limit: number | null
  upper_limit: number | null
  resolution: string | null
  opened_at: string
  updated_at: string
  resolved_at: string | null
}

interface ConnectorRow {
  id: string
  workflow_run_id: string
  name: string
  kind: string
  mode: string
  status: string
  endpoint: string
  credential_ref: string
  capabilities_json: string
  last_seen_at: string | null
  status_message: string | null
  created_at: string
  updated_at: string
}

interface ActionRow {
  id: string
  workflow_run_id: string
  connector_id: string
  operation: string
  payload_json: string
  reason: string
  risk: string
  status: string
  required_approvals: number
  created_by: string
  created_at: string
  resolved_at: string | null
}

interface DecisionRow {
  id: string
  action_id: string
  actor_id: string
  actor_role: string
  decision: string
  comment: string
  created_at: string
}

interface PredictionRow {
  id: string
  workflow_run_id: string
  model: string
  artifact_ref: string
  prediction: string
  conditions: string
  uncertainty: string
  status: string
  linked_experiment: string
  resolution_note: string | null
  created_at: string
  updated_at: string
  tested_at: string | null
  resolved_at: string | null
}

interface AuditRow {
  sequence: number
  id: string
  workflow_run_id: string
  actor_id: string
  actor_role: string
  action: string
  entity_type: string
  entity_id: string
  reason: string
  before_json: string
  after_json: string
  previous_hash: string
  record_hash: string
  created_at: string
}

function profileFrom(row: BatchRow): IndustrialBatchProfile {
  return {
    workflowRunId: row.workflow_run_id,
    batchNumber: row.batch_number,
    productName: row.product_name,
    facility: row.facility,
    area: row.area,
    processCell: row.process_cell,
    unit: row.unit,
    recipeId: row.recipe_id,
    recipeVersion: row.recipe_version,
    mode: row.mode as IndustrialBatchMode,
    status: row.status as IndustrialBatchStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function entityFrom(row: EntityRow): BiologicalEntity {
  const entity: BiologicalEntity = {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    kind: row.kind as BiologicalEntityKind,
    name: row.name,
    externalId: row.external_id,
    version: row.version,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
  }
  if (row.parent_id) entity.parentId = row.parent_id
  return entity
}

function lotFrom(row: LotRow): MaterialLot {
  const lot: MaterialLot = {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    kind: row.kind as MaterialLotKind,
    name: row.name,
    lotNumber: row.lot_number,
    supplier: row.supplier,
    unit: row.unit,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
  }
  if (row.quantity !== null) lot.quantity = row.quantity
  if (row.expires_at) lot.expiresAt = row.expires_at
  return lot
}

function genealogyFrom(row: GenealogyRow): GenealogyLink {
  const link: GenealogyLink = {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    sourceType: row.source_type as GenealogyNodeType,
    sourceId: row.source_id,
    targetType: row.target_type as GenealogyNodeType,
    targetId: row.target_id,
    relationship: row.relationship as GenealogyRelationship,
    unit: row.unit,
    createdAt: row.created_at,
  }
  if (row.quantity !== null) link.quantity = row.quantity
  return link
}

function parameterFrom(row: ParameterRow): ProcessParameter {
  const parameter: ProcessParameter = {
    workflowRunId: row.workflow_run_id,
    key: row.key,
    name: row.name,
    classification: row.classification as ParameterClassification,
    unit: row.unit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.target !== null) parameter.target = row.target
  if (row.lower_limit !== null) parameter.lowerLimit = row.lower_limit
  if (row.upper_limit !== null) parameter.upperLimit = row.upper_limit
  return parameter
}

function telemetryFrom(row: TelemetryRow): TelemetryPoint {
  const point: TelemetryPoint = {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    parameterKey: row.parameter_key,
    value: row.value,
    unit: row.unit,
    quality: row.quality as TelemetryQuality,
    recordedAt: row.recorded_at,
    receivedAt: row.received_at,
  }
  if (row.connector_id) point.connectorId = row.connector_id
  return point
}

function deviationFrom(row: DeviationRow): Deviation {
  const deviation: Deviation = {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    code: row.code,
    title: row.title,
    description: row.description,
    severity: row.severity as DeviationSeverity,
    status: row.status as DeviationStatus,
    source: row.source === 'AUTO_LIMIT' ? 'AUTO_LIMIT' : 'MANUAL',
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
  }
  if (row.parameter_key) deviation.parameterKey = row.parameter_key
  if (row.observed_value !== null) deviation.observedValue = row.observed_value
  if (row.lower_limit !== null) deviation.lowerLimit = row.lower_limit
  if (row.upper_limit !== null) deviation.upperLimit = row.upper_limit
  if (row.resolution) deviation.resolution = row.resolution
  if (row.resolved_at) deviation.resolvedAt = row.resolved_at
  return deviation
}

function connectorFrom(row: ConnectorRow): IndustrialConnector {
  const connector: IndustrialConnector = {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    name: row.name,
    kind: row.kind as ConnectorKind,
    mode: row.mode as ConnectorMode,
    status: row.status as ConnectorStatus,
    endpoint: row.endpoint,
    credentialRef: row.credential_ref,
    capabilities: parseJson<string[]>(row.capabilities_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.last_seen_at) connector.lastSeenAt = row.last_seen_at
  if (row.status_message) connector.statusMessage = row.status_message
  return connector
}

function decisionFrom(row: DecisionRow): IndustrialActionDecision {
  return {
    id: row.id,
    actionId: row.action_id,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    decision: row.decision === 'REJECT' ? 'REJECT' : 'APPROVE',
    comment: row.comment,
    createdAt: row.created_at,
  }
}

function predictionFrom(row: PredictionRow): ModelPrediction {
  const prediction: ModelPrediction = {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    model: row.model,
    artifactRef: row.artifact_ref,
    prediction: row.prediction,
    conditions: row.conditions,
    uncertainty: row.uncertainty,
    status: row.status as ModelPredictionStatus,
    linkedExperiment: row.linked_experiment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.resolution_note) prediction.resolutionNote = row.resolution_note
  if (row.tested_at) prediction.testedAt = row.tested_at
  if (row.resolved_at) prediction.resolvedAt = row.resolved_at
  return prediction
}

function auditFrom(row: AuditRow): IndustrialAuditRecord {
  const record: IndustrialAuditRecord = {
    sequence: row.sequence,
    id: row.id,
    workflowRunId: row.workflow_run_id,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    previousHash: row.previous_hash,
    recordHash: row.record_hash,
    createdAt: row.created_at,
  }
  const before = parseJson<unknown>(row.before_json, null)
  const after = parseJson<unknown>(row.after_json, null)
  if (before !== null) record.before = before
  if (after !== null) record.after = after
  return record
}

// --------------------------------------------------------------------- inputs

export interface BatchProfileInput {
  batchNumber?: unknown
  productName?: unknown
  facility?: unknown
  area?: unknown
  processCell?: unknown
  unit?: unknown
  recipeId?: unknown
  recipeVersion?: unknown
  mode?: unknown
  status?: unknown
  reason?: unknown
}

export interface EntityInput {
  kind?: unknown
  name?: unknown
  externalId?: unknown
  version?: unknown
  parentId?: unknown
  metadata?: unknown
  reason?: unknown
}

export interface LotInput {
  kind?: unknown
  name?: unknown
  lotNumber?: unknown
  supplier?: unknown
  quantity?: unknown
  unit?: unknown
  expiresAt?: unknown
  metadata?: unknown
  reason?: unknown
}

export interface GenealogyInput {
  sourceType?: unknown
  sourceId?: unknown
  targetType?: unknown
  targetId?: unknown
  relationship?: unknown
  quantity?: unknown
  unit?: unknown
  reason?: unknown
}

export interface ParameterInput {
  key?: unknown
  name?: unknown
  classification?: unknown
  unit?: unknown
  target?: unknown
  lowerLimit?: unknown
  upperLimit?: unknown
  reason?: unknown
}

export interface TelemetryInput {
  parameterKey?: unknown
  value?: unknown
  unit?: unknown
  quality?: unknown
  connectorId?: unknown
  recordedAt?: unknown
  reason?: unknown
}

export interface TelemetryResult {
  point: TelemetryPoint
  deviation?: Deviation
}

export interface DeviationInput {
  code?: unknown
  title?: unknown
  description?: unknown
  severity?: unknown
  parameterKey?: unknown
  observedValue?: unknown
  reason?: unknown
}

export interface DeviationResolutionInput {
  status?: unknown
  resolution?: unknown
  reason?: unknown
}

export interface ConnectorInput {
  id?: string
  name?: unknown
  kind?: unknown
  mode?: unknown
  status?: unknown
  endpoint?: unknown
  credentialRef?: unknown
  capabilities?: unknown
  lastSeenAt?: unknown
  statusMessage?: unknown
  reason?: unknown
}

export interface PredictionInput {
  model?: unknown
  artifactRef?: unknown
  prediction?: unknown
  conditions?: unknown
  uncertainty?: unknown
  linkedExperiment?: unknown
  reason?: unknown
}

export interface ActionInput {
  connectorId?: unknown
  operation?: unknown
  payload?: unknown
  reason?: unknown
  risk?: unknown
}
