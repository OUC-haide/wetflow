export const INDUSTRIAL_BATCH_MODES = ['SHADOW', 'ASSISTED', 'CONTROLLED'] as const
export const INDUSTRIAL_BATCH_STATUSES = ['PLANNED', 'RUNNING', 'HELD', 'COMPLETED', 'ABORTED'] as const
export const BIOLOGICAL_ENTITY_KINDS = ['CONSTRUCT', 'PLASMID', 'STRAIN', 'CELL_BANK', 'SEED_LOT', 'CULTURE', 'HARVEST'] as const
export const MATERIAL_LOT_KINDS = ['RAW_MATERIAL', 'MEDIA', 'FEED', 'ANTIFOAM', 'INTERMEDIATE', 'PRODUCT', 'WASTE'] as const
export const GENEALOGY_NODE_TYPES = ['BATCH', 'BIOLOGICAL_ENTITY', 'MATERIAL_LOT'] as const
export const GENEALOGY_RELATIONSHIPS = ['DERIVED_FROM', 'CONSUMED_IN', 'PRODUCED_BY', 'TRANSFERRED_TO', 'SAMPLED_FROM'] as const
export const PARAMETER_CLASSIFICATIONS = ['CPP', 'CQA', 'PROCESS', 'ENVIRONMENTAL'] as const
export const TELEMETRY_QUALITIES = ['GOOD', 'UNCERTAIN', 'BAD'] as const
export const DEVIATION_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export const DEVIATION_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'] as const
export const CONNECTOR_KINDS = ['OPC_UA', 'MES', 'LIMS', 'ELN', 'HISTORIAN', 'QMS', 'ERP', 'CMMS', 'SILA2', 'CUSTOM'] as const
export const CONNECTOR_MODES = ['READ_ONLY', 'PROPOSE', 'CONTROLLED'] as const
export const CONNECTOR_STATUSES = ['OFFLINE', 'ONLINE', 'DEGRADED', 'ERROR'] as const
export const INDUSTRIAL_RISKS = ['LOW', 'MEDIUM', 'HIGH'] as const
export const INDUSTRIAL_ACTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'BLOCKED'] as const
export const MODEL_PREDICTION_STATUSES = ['PROPOSED', 'TESTED', 'CONFIRMED', 'REFUTED', 'WITHDRAWN'] as const

export type IndustrialBatchMode = typeof INDUSTRIAL_BATCH_MODES[number]
export type IndustrialBatchStatus = typeof INDUSTRIAL_BATCH_STATUSES[number]
export type BiologicalEntityKind = typeof BIOLOGICAL_ENTITY_KINDS[number]
export type MaterialLotKind = typeof MATERIAL_LOT_KINDS[number]
export type GenealogyNodeType = typeof GENEALOGY_NODE_TYPES[number]
export type GenealogyRelationship = typeof GENEALOGY_RELATIONSHIPS[number]
export type ParameterClassification = typeof PARAMETER_CLASSIFICATIONS[number]
export type TelemetryQuality = typeof TELEMETRY_QUALITIES[number]
export type DeviationSeverity = typeof DEVIATION_SEVERITIES[number]
export type DeviationStatus = typeof DEVIATION_STATUSES[number]
export type ConnectorKind = typeof CONNECTOR_KINDS[number]
export type ConnectorMode = typeof CONNECTOR_MODES[number]
export type ConnectorStatus = typeof CONNECTOR_STATUSES[number]
export type IndustrialRisk = typeof INDUSTRIAL_RISKS[number]
export type IndustrialActionStatus = typeof INDUSTRIAL_ACTION_STATUSES[number]
export type ModelPredictionStatus = typeof MODEL_PREDICTION_STATUSES[number]

export interface IndustrialActor {
  id: string
  role: string
}

export interface IndustrialBatchProfile {
  workflowRunId: string
  batchNumber: string
  productName: string
  facility: string
  area: string
  processCell: string
  unit: string
  recipeId: string
  recipeVersion: string
  mode: IndustrialBatchMode
  status: IndustrialBatchStatus
  createdAt: string
  updatedAt: string
}

export interface BiologicalEntity {
  id: string
  workflowRunId: string
  kind: BiologicalEntityKind
  name: string
  externalId: string
  version: string
  parentId?: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface MaterialLot {
  id: string
  workflowRunId: string
  kind: MaterialLotKind
  name: string
  lotNumber: string
  supplier: string
  quantity?: number
  unit: string
  expiresAt?: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface GenealogyLink {
  id: string
  workflowRunId: string
  sourceType: GenealogyNodeType
  sourceId: string
  targetType: GenealogyNodeType
  targetId: string
  relationship: GenealogyRelationship
  quantity?: number
  unit: string
  createdAt: string
}

export interface ProcessParameter {
  workflowRunId: string
  key: string
  name: string
  classification: ParameterClassification
  unit: string
  target?: number
  lowerLimit?: number
  upperLimit?: number
  createdAt: string
  updatedAt: string
}

export interface TelemetryPoint {
  id: string
  workflowRunId: string
  parameterKey: string
  value: number
  unit: string
  quality: TelemetryQuality
  connectorId?: string
  recordedAt: string
  receivedAt: string
}

export interface Deviation {
  id: string
  workflowRunId: string
  code: string
  title: string
  description: string
  severity: DeviationSeverity
  status: DeviationStatus
  source: 'MANUAL' | 'AUTO_LIMIT'
  parameterKey?: string
  observedValue?: number
  lowerLimit?: number
  upperLimit?: number
  resolution?: string
  openedAt: string
  updatedAt: string
  resolvedAt?: string
}

export interface IndustrialConnector {
  id: string
  workflowRunId: string
  name: string
  kind: ConnectorKind
  mode: ConnectorMode
  status: ConnectorStatus
  endpoint: string
  credentialRef: string
  capabilities: string[]
  lastSeenAt?: string
  statusMessage?: string
  createdAt: string
  updatedAt: string
}

export interface IndustrialActionDecision {
  id: string
  actionId: string
  actorId: string
  actorRole: string
  decision: 'APPROVE' | 'REJECT'
  comment: string
  createdAt: string
}

export interface IndustrialActionProposal {
  id: string
  workflowRunId: string
  connectorId: string
  operation: string
  payload: Record<string, unknown>
  reason: string
  risk: IndustrialRisk
  status: IndustrialActionStatus
  requiredApprovals: number
  createdBy: string
  createdAt: string
  resolvedAt?: string
  decisions: IndustrialActionDecision[]
  dispatchPermitted: false
}

export interface ModelPrediction {
  id: string
  workflowRunId: string
  model: string
  artifactRef: string
  prediction: string
  conditions: string
  uncertainty: string
  status: ModelPredictionStatus
  linkedExperiment: string
  resolutionNote?: string
  createdAt: string
  updatedAt: string
  testedAt?: string
  resolvedAt?: string
}

export interface IndustrialAuditRecord {
  sequence: number
  id: string
  workflowRunId: string
  actorId: string
  actorRole: string
  action: string
  entityType: string
  entityId: string
  reason: string
  before?: unknown
  after?: unknown
  previousHash: string
  recordHash: string
  createdAt: string
}

export interface IndustrialOverview {
  profile?: IndustrialBatchProfile
  connectors: IndustrialConnector[]
  latestTelemetry: TelemetryPoint[]
  openDeviations: Deviation[]
  counts: {
    biologicalEntities: number
    materialLots: number
    genealogyLinks: number
    parameters: number
    telemetryPoints: number
    pendingActions: number
    pendingPredictions: number
  }
  executionPolicy: {
    phase: 'SHADOW'
    writesEnabled: false
    identityMode: 'development-header'
    message: string
  }
  audit: {
    valid: boolean
    records: number
    headHash: string
  }
}
