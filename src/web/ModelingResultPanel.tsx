import { Download } from 'lucide-react'
import type { ModelMethod, ModelResult, ModelTask } from '../modeling/types.js'
import type { ModelingClient } from './modeling-api.js'
import { ModelingTrajectory } from './ModelingTrajectory.js'
import {
  CONDITIONS_MAX,
  EXPERIMENT_REF_MAX,
  PREDICTION_MAX,
  UNCERTAINTY_MAX,
  fieldUnit,
  formatBytes,
  formatValue,
  methodFields,
  statusLabel,
} from './modeling-format.js'

export interface PredictionDraft {
  id: string
  text: string
  conditions: string
  uncertainty: string
  onText: (value: string) => void
  onConditions: (value: string) => void
  onUncertainty: (value: string) => void
}

export interface ExperimentDraft {
  reference: string
  note: string
  linked: string
  onReference: (value: string) => void
  onNote: (value: string) => void
}

interface Props {
  client: ModelingClient
  task: ModelTask
  method: ModelMethod | undefined
  result: ModelResult
  datasetName?: string | undefined
  /** Server-advertised experiment note cap (`methods().limits.maxExperimentNote`). */
  maxExperimentNote: number
  prediction: PredictionDraft
  experiment: ExperimentDraft
  pending: ReadonlySet<string>
  onRegister: () => void
  onLink: () => void
}

function DefinitionList({ entries }: { entries: Array<[string, string]> }) {
  return (
    <dl className="modeling-definitions">
      {entries.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function artifactLabel(mediaType: string, name: string): string {
  if (mediaType.includes('json')) return `下载 JSON 结果（${name}）`
  if (mediaType.includes('csv')) return `下载 CSV 数据（${name}）`
  return `下载 ${name}`
}

/**
 * Presentational result view: real metrics, diagnostics, units, requested
 * parameters, assumptions, artifacts, trajectory data and the editable
 * prediction / experiment association form.
 */
export function ModelingResultPanel({
  client, task, method, result, datasetName, maxExperimentNote, prediction, experiment, pending, onRegister, onLink,
}: Props) {
  const fields = methodFields(method)
  const parameterEntries: Array<[string, string]> = fields
    .filter(field => task.parameters[field.key] !== undefined)
    .map(field => [
      `${field.label} (${field.key})`,
      formatValue(task.parameters[field.key], field.unit || fieldUnit(field.key)),
    ])
  if (task.datasetId) parameterEntries.push(['输入数据集', datasetName ? `${datasetName} (${task.datasetId})` : task.datasetId])
  const metricEntries = Object.entries(result.metrics ?? {})
  const diagnosticEntries = Object.entries(result.diagnostics ?? {})
  const summaryEntries = Object.entries(result.summary ?? {})
  const registered = !!prediction.id
  const predictionLength = prediction.text.trim().length
  const registerDisabled = registered || predictionLength < 2 || predictionLength > PREDICTION_MAX || pending.has('predict')
  const linkDisabled = !registered || !experiment.reference.trim() || !!experiment.linked || pending.has('link')

  return (
    <article className="modeling-card" data-testid="modeling-result">
      <header className="modeling-result-head">
        <h2>任务结果</h2>
        <span className="modeling-badge">{method?.label ?? result.method}</span>
        <span className="modeling-badge">v{result.methodVersion}</span>
        <span className={`modeling-status modeling-status--${task.status.toLowerCase()}`}>{statusLabel(task.status)}</span>
      </header>
      <p className="modeling-caption">
        任务 <code>{task.id}</code> · {task.title} · 创建于 {new Date(task.createdAt).toLocaleString()}
      </p>

      {metricEntries.length > 0 && (
        <>
          <h3>关键指标（含单位）</h3>
          <dl className="modeling-metrics">
            {metricEntries.map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{formatValue(value, result.units?.[name])}</dd>
              </div>
            ))}
          </dl>
        </>
      )}

      {diagnosticEntries.length > 0 && (
        <>
          <h3>拟合诊断（不是不确定度）</h3>
          <dl className="modeling-metrics modeling-metrics--diagnostics">
            {diagnosticEntries.map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{formatValue(value, result.units?.[name])}</dd>
              </div>
            ))}
          </dl>
        </>
      )}

      {result.uncertaintyNote && <div className="modeling-note modeling-note--warn">{result.uncertaintyNote}</div>}

      {summaryEntries.length > 0 && (
        <>
          <h3>结果摘要</h3>
          <DefinitionList entries={summaryEntries.map(([name, value]) => [name, formatValue(value, result.units?.[name])])} />
        </>
      )}

      {parameterEntries.length > 0 && (
        <>
          <h3>请求参数</h3>
          <DefinitionList entries={parameterEntries} />
        </>
      )}

      <h3>下载</h3>
      {result.artifacts.length === 0 && <p className="modeling-caption">后端没有返回可下载文件。</p>}
      {result.artifacts.map(artifact => (
        <a className="modeling-artifact" key={artifact.id} href={client.artifactUrl(task.id, artifact.id)} download>
          <Download size={14} />{artifactLabel(artifact.mediaType, artifact.name)}
          <small>{artifact.mediaType} · {formatBytes(artifact.sizeBytes)}</small>
        </a>
      ))}
      {result.artifacts.length > 0 && (
        <p className="modeling-caption">
          result.json 是数值工作进程返回的原始结构化结果（方法、版本、指标、单位、假设）；output.csv 是完整数值轨迹。两者均由后端按运行归属校验后下载。
        </p>
      )}

      <h3>结果轨迹</h3>
      <ModelingTrajectory client={client} taskId={task.id} artifacts={result.artifacts} />

      {result.assumptions.length > 0 && (
        <>
          <h3>模型假设</h3>
          <ul>{result.assumptions.map(assumption => <li key={assumption}>{assumption}</li>)}</ul>
        </>
      )}
      {result.limitations.length > 0 && (
        <>
          <h3>已知限制</h3>
          <ul>{result.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul>
        </>
      )}

      <h3>登记预测</h3>
      <p className="modeling-caption">
        登记会写入工业预测记录（状态 <b>PROPOSED</b>）。请保留简洁、可复核的表述；指标是模型输出，不是不确定度声明。
      </p>
      <label className="modeling-field">
        预测摘要（{predictionLength}/{PREDICTION_MAX}）
        <textarea
          value={prediction.text}
          maxLength={PREDICTION_MAX}
          disabled={registered}
          onChange={event => prediction.onText(event.target.value)}
          rows={3}
        />
      </label>
      <label className="modeling-field">
        适用条件（{prediction.conditions.trim().length}/{CONDITIONS_MAX}）
        <textarea
          value={prediction.conditions}
          maxLength={CONDITIONS_MAX}
          disabled={registered}
          onChange={event => prediction.onConditions(event.target.value)}
          rows={2}
        />
      </label>
      <label className="modeling-field">
        不确定度声明（{prediction.uncertainty.trim().length}/{UNCERTAINTY_MAX}，可留空）
        <textarea
          value={prediction.uncertainty}
          maxLength={UNCERTAINTY_MAX}
          disabled={registered}
          placeholder="除非你能给出真实区间，否则请留空。拟合诊断（rSquared/logRmse）不是不确定度。"
          onChange={event => prediction.onUncertainty(event.target.value)}
          rows={2}
        />
      </label>
      <div className="modeling-link">
        <button className="button button--primary" disabled={registerDisabled} onClick={onRegister}>
          {registered ? '预测已登记' : '登记为预测'}
        </button>
        {registered && <code>{prediction.id}</code>}
      </div>
      {registered && <p className="modeling-caption">重复登记是幂等的：后端不会改写已登记文本，请到预测记录中查看或修订。</p>}

      <h3>关联实验（PROPOSED）</h3>
      <div className="modeling-form-grid">
        <label className="modeling-field">
          实验记录引用（≤{EXPERIMENT_REF_MAX} 字）
          <input
            value={experiment.reference}
            maxLength={EXPERIMENT_REF_MAX}
            disabled={!registered || !!experiment.linked}
            placeholder="例如 ELN 编号或 LIMS 实验 ID"
            onChange={event => experiment.onReference(event.target.value)}
          />
        </label>
        <label className="modeling-field">
          关联备注（可选，≤{maxExperimentNote} 字）
          <input
            value={experiment.note}
            maxLength={maxExperimentNote}
            disabled={!registered || !!experiment.linked || pending.has('link')}
            placeholder="例如计划中的验证方式"
            onChange={event => experiment.onNote(event.target.value)}
          />
        </label>
      </div>
      <div className="modeling-link">
        <button className="button button--quiet" disabled={linkDisabled} onClick={onLink}>关联实验</button>
        {experiment.linked && <span className="modeling-badge">已关联：{experiment.linked}（PROPOSED）</span>}
      </div>
      <div className="modeling-note">
        关联实验只建立引用，不表示实验已经完成，也不会把预测自动标记为已测试或已确认。预测仍是模型产物，不是湿实验测量。
      </div>
    </article>
  )
}
