import { useEffect, useState } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import type { ModelArtifact } from '../modeling/types.js'
import { type ModelingClient, errorMessage, isAbortError } from './modeling-api.js'
import {
  type TrajectoryData,
  buildTrajectory,
  formatBytes,
  parseCsv,
  seriesColor,
} from './modeling-format.js'

const TABLE_LIMIT = 100
const CHART_POINTS = 240
const CHART_WIDTH = 660
const CHART_HEIGHT = 240
const PADDING = { top: 16, right: 18, bottom: 46, left: 58 }

function downsample(data: TrajectoryData): number[] {
  const count = data.time.length
  if (count <= CHART_POINTS) return data.time.map((_, index) => index)
  const step = Math.ceil(count / CHART_POINTS)
  const indices: number[] = []
  for (let index = 0; index < count; index += step) indices.push(index)
  if (indices.at(-1) !== count - 1) indices.push(count - 1)
  return indices
}

function TrajectoryChart({ data }: { data: TrajectoryData }) {
  const indices = downsample(data)
  const times = indices.map(index => data.time[index] ?? 0)
  const xMin = Math.min(...times)
  const xMax = Math.max(...times)
  const values = data.series.flatMap(series => indices.map(index => series.values[index] ?? 0))
  const yMin = Math.min(0, ...values)
  const yMax = Math.max(...values, yMin + 1e-12)
  const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right
  const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom
  const x = (value: number) => PADDING.left + ((value - xMin) / (xMax - xMin || 1)) * plotWidth
  const y = (value: number) => PADDING.top + plotHeight - ((value - yMin) / (yMax - yMin || 1)) * plotHeight
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(ratio => yMin + ratio * (yMax - yMin))
  const axisLabel = data.headers[0] ?? 'x'
  const yUnitLabel = data.yUnit ?? '数值'
  const seriesNames = data.series.map(series => series.name).join('、')
  return (
    <div className="modeling-chart-block">
      <svg className="modeling-chart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={`结果轨迹图：${seriesNames} 对 ${axisLabel}，纵轴单位 ${yUnitLabel}`}>
        <title>结果轨迹图：{seriesNames} 对 {axisLabel}，纵轴单位 {yUnitLabel}</title>
        {ticks.map(tick => (
          <g key={`tick-${tick}`}>
            <line x1={PADDING.left} x2={CHART_WIDTH - PADDING.right} y1={y(tick)} y2={y(tick)} className="modeling-chart-grid" />
            <text x={PADDING.left - 6} y={y(tick) + 3} textAnchor="end" className="modeling-chart-label">{tick.toPrecision(3)}</text>
          </g>
        ))}
        <text
          className="modeling-chart-label"
          data-testid="chart-y-unit"
          x={13}
          y={PADDING.top + plotHeight / 2}
          textAnchor="middle"
          transform={`rotate(-90 13 ${PADDING.top + plotHeight / 2})`}
        >{yUnitLabel}</text>
        <text x={PADDING.left} y={CHART_HEIGHT - 26} className="modeling-chart-label">{xMin.toPrecision(3)}</text>
        <text x={CHART_WIDTH - PADDING.right} y={CHART_HEIGHT - 26} textAnchor="end" className="modeling-chart-label">{xMax.toPrecision(3)}</text>
        <text x={PADDING.left + plotWidth / 2} y={CHART_HEIGHT - 8} textAnchor="middle" className="modeling-chart-label">{axisLabel}</text>
        {data.series.map((series, seriesIndex) => (
          <polyline
            key={series.name}
            fill="none"
            stroke={seriesColor(seriesIndex)}
            strokeWidth={1.6}
            points={indices.map(index => `${x(data.time[index] ?? 0).toFixed(2)},${y(series.values[index] ?? 0).toFixed(2)}`).join(' ')}
          />
        ))}
      </svg>
      <div className="modeling-chart-legend">
        {data.series.map((series, seriesIndex) => (
          <span key={series.name}><i style={{ backgroundColor: seriesColor(seriesIndex) }} />{series.name}</span>
        ))}
      </div>
      {data.omitted.length > 0 && (
        <p className="modeling-caption" data-testid="chart-omitted-note">
          图中纵轴只绘制{data.yUnit ? `单位 ${data.yUnit} 的` : ''}系列；{data.omitted.join('、')} 与纵轴单位不同，未画入该图，仅在下表与下载的 CSV 中提供。
        </p>
      )}
    </div>
  )
}

function TrajectoryTable({ data }: { data: TrajectoryData }) {
  const rows = data.rows.slice(0, TABLE_LIMIT)
  return (
    <>
      <div className="modeling-table-scroll">
        <table className="modeling-table" data-testid="trajectory-table">
          <thead>
            <tr>{data.headers.map(header => <th key={header}>{header}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>{data.headers.map((header, column) => <td key={header}>{row[column] ?? ''}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="modeling-caption">
        共 {data.rows.length} 行{data.rows.length > TABLE_LIMIT ? `，表中仅显示前 ${TABLE_LIMIT} 行` : ''}；完整数据请下载 CSV。
      </p>
    </>
  )
}

interface TrajectoryProps {
  client: ModelingClient
  taskId: string
  artifacts: ModelArtifact[]
}

/**
 * Loads the real trajectory/fitted CSV artifact for the current task and
 * renders it as a chart plus table. The artifact fetch is aborted when the
 * task changes or the component unmounts so no stale table can appear.
 */
export function ModelingTrajectory({ client, taskId, artifacts }: TrajectoryProps) {
  const artifact = artifacts.find(item => item.mediaType.includes('csv') || item.name.toLowerCase().endsWith('.csv'))
  const artifactId = artifact?.id
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; data?: TrajectoryData; error?: string }>(
    { status: 'idle' },
  )

  useEffect(() => {
    if (!artifactId) {
      setState({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    let cancelled = false
    setState({ status: 'loading' })
    client.artifactText(taskId, artifactId, controller.signal)
      .then(text => {
        if (cancelled) return
        const data = buildTrajectory(parseCsv(text))
        if (!data) {
          setState({ status: 'error', error: '结果 CSV 不是可识别的数值轨迹' })
          return
        }
        setState({ status: 'ready', data })
      })
      .catch(error => {
        if (cancelled || isAbortError(error)) return
        setState({ status: 'error', error: errorMessage(error) })
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [client, taskId, artifactId])

  if (!artifact) {
    return <p className="modeling-caption">后端没有为该结果提供 CSV 轨迹文件。</p>
  }

  return (
    <div className="modeling-trajectory" data-testid="modeling-trajectory">
      <div className="modeling-artifact-row">
        <a className="modeling-artifact" href={client.artifactUrl(taskId, artifact.id)} download>
          <Download size={14} />下载轨迹 {artifact.name}<small>{formatBytes(artifact.sizeBytes)}</small>
        </a>
      </div>
      {state.status === 'loading' && <div className="modeling-empty"><LoaderCircle className="spin" size={13} /> 正在读取轨迹文件…</div>}
      {state.status === 'error' && <div className="modeling-alert modeling-alert--error" role="alert">{state.error}</div>}
      {state.status === 'ready' && state.data && <TrajectoryChart data={state.data} />}
      {state.status === 'ready' && state.data && <TrajectoryTable data={state.data} />}
    </div>
  )
}
