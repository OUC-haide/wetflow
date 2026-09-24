import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Beaker, CircleAlert, FlaskConical, LoaderCircle, Play, Plus, RefreshCw, X } from 'lucide-react'
import type { Dataset, ModelMethod, ModelResult, ModelTask } from '../modeling/types.js'
import { ModelingClient, errorMessage, isAbortError, type ModelLimits, type SubmitInput } from './modeling-api.js'
import { ModelingResultPanel } from './ModelingResultPanel.js'
import {
  BUDGET_OPTIONS,
  CONDITIONS_MAX,
  CSV_MAX_BYTES,
  DEFAULT_MAX_OUTPUT_ROWS,
  EXPERIMENT_NOTE_MAX,
  EXPERIMENT_REF_MAX,
  MAX_OUTPUT_ROWS,
  PREDICTION_MAX,
  UNCERTAINTY_MAX,
  draftConditions,
  draftPrediction,
  expectedTrajectoryRows,
  formatBytes,
  isTerminal,
  methodFields,
  statusLabel,
  validateParameters,
} from './modeling-format.js'

const POLL_INTERVAL_MS = 1500

export function ModelingWorkspace({ runId }: { runId: string }) {
  const client = useMemo(() => new ModelingClient(runId), [runId])

  // ---------------------------------------------------------------- state
  const [methods, setMethods] = useState<ModelMethod[]>([])
  const [limits, setLimits] = useState<ModelLimits>()
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [tasks, setTasks] = useState<ModelTask[]>([])
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [selectedMethod, setSelectedMethod] = useState('monod_batch')
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [datasetId, setDatasetId] = useState('')
  const [title, setTitle] = useState('')
  const [budgetSeconds, setBudgetSeconds] = useState<number>(30)
  const [file, setFile] = useState<File>()

  const [activeTaskId, setActiveTaskId] = useState<string>()
  const [result, setResult] = useState<ModelResult>()
  const [resultTaskId, setResultTaskId] = useState<string>()
  const [resultLoading, setResultLoading] = useState(false)
  const [resultError, setResultError] = useState('')

  const [predictionId, setPredictionId] = useState('')
  const [predictionText, setPredictionText] = useState('')
  const [conditionsText, setConditionsText] = useState('')
  const [uncertaintyText, setUncertaintyText] = useState('')
  const [experimentReference, setExperimentReference] = useState('')
  const [experimentNote, setExperimentNote] = useState('')
  const [linkedExperiment, setLinkedExperiment] = useState('')

  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  // Prefer the server-advertised note cap; fall back to the frozen service default.
  const maxExperimentNote = limits?.maxExperimentNote ?? EXPERIMENT_NOTE_MAX

  // ---------------------------------------------------------------- refs
  // `generationRef` invalidates every in-flight async read when the run, the
  // selected task or the component lifecycle changes. A response is only
  // applied when both the generation and the bound task ID still match.
  const generationRef = useRef(0)
  const activeTaskIdRef = useRef<string | undefined>(undefined)
  const resultTaskIdRef = useRef<string | undefined>(undefined)
  const tasksRef = useRef<ModelTask[]>([])
  const datasetsRef = useRef<Dataset[]>([])
  const methodsRef = useRef<ModelMethod[]>([])
  const linkedExperimentRef = useRef('')
  const resultLoadingRef = useRef(false)
  const pollBusyRef = useRef(false)
  const pendingRef = useRef<ReadonlySet<string>>(new Set())
  const resultAbortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const updatePending = useCallback((mutate: (keys: Set<string>) => void) => {
    const next = new Set(pendingRef.current)
    mutate(next)
    pendingRef.current = next
    setPending(next)
  }, [])

  // ---------------------------------------------------------------- async reads
  const loadResult = useCallback(async (taskId: string, generationAtStart: number) => {
    resultAbortRef.current?.abort()
    const controller = new AbortController()
    resultAbortRef.current = controller
    resultLoadingRef.current = true
    setResultLoading(true)
    setResultError('')
    try {
      const data = await client.result(taskId, controller.signal)
      if (generationRef.current !== generationAtStart || activeTaskIdRef.current !== taskId) return
      resultTaskIdRef.current = taskId
      setResult(data)
      setResultTaskId(taskId)
      const task = tasksRef.current.find(item => item.id === taskId)
      if (task && !task.predictionId) {
        const dataset = task.datasetId ? datasetsRef.current.find(item => item.id === task.datasetId) : undefined
        setPredictionText(draftPrediction(task, data))
        setConditionsText(draftConditions(task, methodsRef.current.find(item => item.id === task.method), dataset?.name))
      }
    } catch (caught) {
      if (isAbortError(caught) || generationRef.current !== generationAtStart || activeTaskIdRef.current !== taskId) return
      setResultError(errorMessage(caught))
    } finally {
      if (generationRef.current === generationAtStart) {
        resultLoadingRef.current = false
        setResultLoading(false)
      }
    }
  }, [client])

  const applyTaskList = useCallback((list: ModelTask[]) => {
    tasksRef.current = list
    setTasks(list)
    const activeId = activeTaskIdRef.current
    if (!activeId) return
    const task = list.find(item => item.id === activeId)
    if (!task) return
    // Terminal polling must hydrate the persisted registration/experiment
    // linkage, but it must never overwrite in-progress prediction edits.
    setPredictionId(task.predictionId ?? '')
    if (task.linkedExperiment && linkedExperimentRef.current !== task.linkedExperiment) {
      linkedExperimentRef.current = task.linkedExperiment
      setLinkedExperiment(task.linkedExperiment)
      setExperimentReference(task.linkedExperiment)
    }
    if (task.status === 'SUCCEEDED') {
      if (resultTaskIdRef.current !== task.id && !resultLoadingRef.current) void loadResult(task.id, generationRef.current)
    } else {
      resultTaskIdRef.current = undefined
      setResult(undefined)
      setResultTaskId(undefined)
    }
  }, [loadResult])

  const loadWorkspace = useCallback(async () => {
    if (!runId) return
    const generationAtStart = generationRef.current
    setWorkspaceLoading(true)
    try {
      const [methodResponse, datasetResponse, taskResponse] = await Promise.all([
        client.methods(),
        client.datasets(),
        client.tasks(),
      ])
      if (generationRef.current !== generationAtStart) return
      methodsRef.current = methodResponse.items
      datasetsRef.current = datasetResponse.items
      setMethods(methodResponse.items)
      setDatasets(datasetResponse.items)
      if (methodResponse.limits) setLimits(methodResponse.limits)
      applyTaskList(taskResponse.items)
    } catch (caught) {
      if (isAbortError(caught) || generationRef.current !== generationAtStart) return
      setError(errorMessage(caught))
    } finally {
      if (generationRef.current === generationAtStart) setWorkspaceLoading(false)
    }
  }, [applyTaskList, client, runId])

  const pollTasks = useCallback(async () => {
    if (!runId || pollBusyRef.current) return
    pollBusyRef.current = true
    const generationAtStart = generationRef.current
    try {
      const response = await client.tasks()
      if (generationRef.current !== generationAtStart) return
      applyTaskList(response.items)
    } catch (caught) {
      if (!isAbortError(caught) && generationRef.current === generationAtStart) setError(errorMessage(caught))
    } finally {
      pollBusyRef.current = false
    }
  }, [applyTaskList, client, runId])

  // ---------------------------------------------------------------- lifecycle
  useEffect(() => {
    generationRef.current += 1
    resultAbortRef.current?.abort()
    activeTaskIdRef.current = undefined
    resultTaskIdRef.current = undefined
    linkedExperimentRef.current = ''
    resultLoadingRef.current = false
    pollBusyRef.current = false
    tasksRef.current = []
    datasetsRef.current = []
    methodsRef.current = []
    pendingRef.current = new Set()
    setPending(pendingRef.current)
    setMethods([])
    setLimits(undefined)
    setDatasets([])
    setTasks([])
    setActiveTaskId(undefined)
    setResult(undefined)
    setResultTaskId(undefined)
    setResultLoading(false)
    setResultError('')
    setWorkspaceLoading(false)
    setPredictionId('')
    setPredictionText('')
    setConditionsText('')
    setUncertaintyText('')
    setExperimentReference('')
    setExperimentNote('')
    setLinkedExperiment('')
    setError('')
    setNotice('')
    setFieldErrors({})
    setParameterValues({})
    setDatasetId('')
    setFile(undefined)
    if (runId) void loadWorkspace()
    return () => {
      generationRef.current += 1
      resultAbortRef.current?.abort()
    }
  }, [loadWorkspace, runId])

  // Polling runs only while at least one task is non-terminal, and the timer
  // is cleared on unmount, run change and the moment every task settles.
  const hasNonTerminal = tasks.some(task => !isTerminal(task.status))
  useEffect(() => {
    if (!runId || !hasNonTerminal) return
    const timer = window.setInterval(() => { void pollTasks() }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [hasNonTerminal, pollTasks, runId])

  useEffect(() => {
    if (methods.length > 0 && !methods.some(method => method.id === selectedMethod)) {
      setSelectedMethod(methods[0]!.id)
    }
  }, [methods, selectedMethod])

  useEffect(() => () => { resultAbortRef.current?.abort() }, [])

  // ---------------------------------------------------------------- actions
  const runMutation = useCallback(async (key: string, action: () => Promise<void>) => {
    if (pendingRef.current.has(key)) return
    updatePending(keys => keys.add(key))
    setError('')
    try {
      await action()
    } catch (caught) {
      if (!isAbortError(caught)) setError(errorMessage(caught))
    } finally {
      updatePending(keys => keys.delete(key))
    }
  }, [updatePending])

  /** Bind the UI to one task and drop every previously loaded result/registration. */
  const focusTask = useCallback((task: ModelTask) => {
    generationRef.current += 1
    resultAbortRef.current?.abort()
    activeTaskIdRef.current = task.id
    resultTaskIdRef.current = undefined
    linkedExperimentRef.current = task.linkedExperiment ?? ''
    resultLoadingRef.current = false
    setActiveTaskId(task.id)
    setResult(undefined)
    setResultTaskId(undefined)
    setResultLoading(false)
    setResultError('')
    setPredictionId(task.predictionId ?? '')
    setPredictionText('')
    setConditionsText('')
    setUncertaintyText('')
    setExperimentReference(task.linkedExperiment ?? '')
    setExperimentNote(task.linkedExperimentNote ?? '')
    setLinkedExperiment(task.linkedExperiment ?? '')
    setNotice('')
  }, [])

  const selectTask = useCallback((task: ModelTask) => {
    focusTask(task)
    if (task.status === 'SUCCEEDED') void loadResult(task.id, generationRef.current)
  }, [focusTask, loadResult])

  const uploadDataset = useCallback(async () => {
    if (!file || !runId) return
    // Bound the read before touching the file contents.
    if (file.size === 0) {
      setError('CSV 文件为空，请选择包含 time,biomass 数据行的文件。')
      return
    }
    if (file.size > CSV_MAX_BYTES) {
      setError(`CSV 文件为 ${formatBytes(file.size)}，超过 ${formatBytes(CSV_MAX_BYTES)} 上限；请在导入前拆分数据。`)
      return
    }
    await runMutation('upload', async () => {
      const csv = await file.text()
      if (csv.length > CSV_MAX_BYTES) throw new Error(`CSV 文本超过 ${formatBytes(CSV_MAX_BYTES)} 上限`)
      const dataset = await client.createDataset(file.name || 'dataset.csv', csv)
      datasetsRef.current = [dataset, ...datasetsRef.current]
      setDatasets(datasetsRef.current)
      setDatasetId(dataset.id)
      setFile(undefined)
      if (fileInputRef.current) fileInputRef.current.value = ''
      setNotice(`已导入数据集 ${dataset.name}（${dataset.rowCount} 行，列：${dataset.columns.join(', ')}）`)
    })
  }, [client, file, runId, runMutation])

  const applySampleParameters = useCallback(() => {
    const method = methodsRef.current.find(item => item.id === selectedMethod)
    const next: Record<string, string> = {}
    for (const field of methodFields(method)) if (field.example) next[field.key] = field.example
    setParameterValues(next)
    setFieldErrors({})
  }, [selectedMethod])

  const currentMethodModel = methods.find(method => method.id === selectedMethod)
  const previewRows = expectedTrajectoryRows(Number(parameterValues.duration), Number(parameterValues.timeStep))

  const submitTask = useCallback(async () => {
    if (!runId) return
    const method = methodsRef.current.find(item => item.id === selectedMethod)
    const fields = methodFields(method)
    const { values, errors } = validateParameters(fields, parameterValues)
    const nextErrors = { ...errors }
    if (selectedMethod === 'monod_batch') {
      if (values.duration !== undefined && values.timeStep !== undefined && values.timeStep > values.duration) {
        nextErrors.timeStep = '步长不能大于模拟时长'
      }
      const rows = expectedTrajectoryRows(values.duration, values.timeStep)
      if (rows !== undefined && rows > MAX_OUTPUT_ROWS) {
        nextErrors.timeStep = `预计输出 ${rows} 行，超过上限 ${MAX_OUTPUT_ROWS}；请增大步长或缩短时长`
      }
    }
    if (selectedMethod === 'growth_fit' && !datasetId) {
      setError('请选择用于指数生长期拟合的数据集')
      return
    }
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors)
      return
    }
    setFieldErrors({})
    const selectedDataset = datasetsRef.current.find(item => item.id === datasetId)
    const requestedRows = selectedMethod === 'monod_batch'
      ? expectedTrajectoryRows(values.duration, values.timeStep) ?? DEFAULT_MAX_OUTPUT_ROWS
      : selectedDataset?.rowCount ?? DEFAULT_MAX_OUTPUT_ROWS
    const input: SubmitInput = {
      method: selectedMethod,
      parameters: values,
      budget: {
        wallTimeMs: budgetSeconds * 1000,
        maxOutputRows: Math.max(2, Math.min(MAX_OUTPUT_ROWS, requestedRows)),
      },
    }
    if (selectedMethod === 'growth_fit') input.datasetId = datasetId
    if (title.trim()) input.title = title.trim()
    await runMutation('submit', async () => {
      const task = await client.submit(input)
      tasksRef.current = [task, ...tasksRef.current]
      setTasks(tasksRef.current)
      focusTask(task)
      if (task.status === 'SUCCEEDED') void loadResult(task.id, generationRef.current)
      setNotice(`任务已提交：${task.id}（${statusLabel(task.status)}），可稍后回到本页查看状态。`)
    })
  }, [budgetSeconds, client, datasetId, focusTask, loadResult, parameterValues, runId, runMutation, selectedMethod, title])

  const cancelTask = useCallback(async (task: ModelTask) => {
    await runMutation(`cancel:${task.id}`, async () => {
      await client.cancel(task.id)
      await pollTasks()
    })
  }, [client, pollTasks, runMutation])

  const registerPrediction = useCallback(async () => {
    const taskId = activeTaskIdRef.current
    if (!taskId || !result) return
    const generationAtStart = generationRef.current
    const text = predictionText.trim()
    if (text.length < 2 || text.length > PREDICTION_MAX) {
      setError(`预测摘要需为 2-${PREDICTION_MAX} 字`)
      return
    }
    if (conditionsText.trim().length > CONDITIONS_MAX) {
      setError(`适用条件不能超过 ${CONDITIONS_MAX} 字`)
      return
    }
    if (uncertaintyText.trim().length > UNCERTAINTY_MAX) {
      setError(`不确定度声明不能超过 ${UNCERTAINTY_MAX} 字`)
      return
    }
    await runMutation('predict', async () => {
      const registration = await client.registerPrediction(taskId, {
        prediction: text,
        conditions: conditionsText.trim(),
        uncertainty: uncertaintyText.trim(),
      })
      // A mutation that resolves after the user switched tasks must not
      // attach its prediction ID to the newly selected task.
      if (generationRef.current !== generationAtStart || activeTaskIdRef.current !== taskId) return
      setPredictionId(registration.predictionId)
      setNotice('预测已登记为 PROPOSED；关联实验不会改变确认状态。')
      applyTaskList([registration.task, ...tasksRef.current.filter(item => item.id !== registration.task.id)])
    })
  }, [applyTaskList, client, conditionsText, predictionText, result, runMutation, uncertaintyText])

  const linkExperimentTask = useCallback(async () => {
    const taskId = activeTaskIdRef.current
    if (!taskId || !predictionId) return
    const generationAtStart = generationRef.current
    const reference = experimentReference.trim()
    if (!reference) {
      setError('请填写实验记录引用')
      return
    }
    if (reference.length > EXPERIMENT_REF_MAX) {
      setError(`实验记录引用不能超过 ${EXPERIMENT_REF_MAX} 字`)
      return
    }
    if (experimentNote.trim().length > maxExperimentNote) {
      setError(`关联备注不能超过 ${maxExperimentNote} 字`)
      return
    }
    await runMutation('link', async () => {
      const task = await client.linkExperiment(taskId, { experimentRef: reference, note: experimentNote.trim() })
      if (generationRef.current !== generationAtStart || activeTaskIdRef.current !== taskId) return
      linkedExperimentRef.current = task.linkedExperiment ?? reference
      setLinkedExperiment(linkedExperimentRef.current)
      setNotice('已建立实验引用：预测保持 PROPOSED，关联不代表实验已完成或预测被确认。')
      applyTaskList([task, ...tasksRef.current.filter(item => item.id !== task.id)])
    })
  }, [applyTaskList, client, experimentNote, experimentReference, maxExperimentNote, predictionId, runMutation])

  // ---------------------------------------------------------------- derived view
  const activeTask = tasks.find(task => task.id === activeTaskId)
  const resultMatchesActive = !!result && !!activeTask && result.taskId === activeTask.id
  const mutationBusy = pending.size > 0
  const initialLoading = !!runId && methods.length === 0 && !error

  return (
    <section className="modeling-page" aria-label="建模工作区">
      <header className="modeling-heading">
        <div>
          <span className="eyebrow">当前运行 · {runId || '未选择运行'}</span>
          <h1><FlaskConical size={22} /> 生物过程建模</h1>
          <p>计算结果是模型预测，不是实验测量。任务在后台异步运行并按当前工作流运行隔离保存。</p>
        </div>
        <button className="button button--quiet" disabled={!runId || workspaceLoading} onClick={() => void loadWorkspace()}>
          {workspaceLoading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} 刷新
        </button>
      </header>

      {!runId && <div className="modeling-alert"><CircleAlert size={16} />请先在左侧选择一个项目与工作流运行。</div>}
      {error && (
        <div className="modeling-alert modeling-alert--error" role="alert">
          <CircleAlert size={16} />{error}
          <button onClick={() => setError('')} aria-label="关闭错误提示"><X size={14} /></button>
        </div>
      )}
      {notice && (
        <div className="modeling-alert modeling-alert--notice" role="status">
          {notice}
          <button onClick={() => setNotice('')} aria-label="关闭提示"><X size={14} /></button>
        </div>
      )}

      <div className="modeling-columns">
        <div className="modeling-main">
          <article className="modeling-card">
            <h2><Beaker size={16} /> 数据集</h2>
            <p>增长拟合需要 CSV，包含数值 time（h）与 biomass（g/L）列；文件上限 {formatBytes(CSV_MAX_BYTES)}。数据以文本上传，服务端不执行任何用户代码。</p>
            <div className="modeling-upload">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                disabled={!runId || mutationBusy}
                onChange={event => setFile(event.target.files?.[0])}
              />
              <button className="button button--quiet" disabled={!file || !runId || mutationBusy} onClick={() => void uploadDataset()}>
                {pending.has('upload') ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} 导入 CSV
              </button>
            </div>
            {file && <p className="modeling-caption">待导入：{file.name} · {formatBytes(file.size)}</p>}
            {datasets.length === 0
              ? <div className="modeling-empty">当前运行暂无数据集。导入 CSV 后即可用于增长拟合。</div>
              : (
                <label className="modeling-field">
                  已导入数据集
                  <select value={datasetId} onChange={event => setDatasetId(event.target.value)}>
                    <option value="">选择数据集（growth_fit 必选）</option>
                    {datasets.map(dataset => (
                      <option key={dataset.id} value={dataset.id}>
                        {dataset.name} · {dataset.rowCount} 行 · {dataset.columns.join(', ')}
                      </option>
                    ))}
                  </select>
                </label>
              )}
          </article>

          <article className="modeling-card">
            <h2><Activity size={16} /> 新建计算任务</h2>
            <label className="modeling-field">
              方法
              <select value={selectedMethod} onChange={event => { setSelectedMethod(event.target.value); setFieldErrors({}) }}>
                {methods.map(method => <option key={method.id} value={method.id}>{method.label} · {method.id} · v{method.version}</option>)}
                {methods.length === 0 && <option value="monod_batch">Monod 批次模拟（等待方法元数据）</option>}
              </select>
            </label>
            <p>{currentMethodModel?.description ?? '正在读取后端方法元数据；不可用时可点击“刷新”重试。'}</p>
            {currentMethodModel && (
              <div className="modeling-note">
                <b>假设：</b>{currentMethodModel.assumptions.join('；')}
                {currentMethodModel.limitations.length > 0 && <><br /><b>限制：</b>{currentMethodModel.limitations.join('；')}</>}
              </div>
            )}

            {selectedMethod === 'monod_batch' && (
              <>
                <div className="modeling-form-grid">
                  {methodFields(currentMethodModel).map(field => (
                    <label className="modeling-field" key={field.key}>
                      {field.label}{field.unit ? `（${field.unit}）` : ''}{field.required ? ' *' : ''}
                      <input
                        type="number"
                        step="any"
                        value={parameterValues[field.key] ?? ''}
                        placeholder={field.example ? `例如 ${field.example}` : ''}
                        onChange={event => setParameterValues(values => ({ ...values, [field.key]: event.target.value }))}
                      />
                      {fieldErrors[field.key] && <small className="modeling-field-error">{fieldErrors[field.key]}</small>}
                    </label>
                  ))}
                </div>
                <p className="modeling-caption">
                  预计输出 {previewRows !== undefined ? `${previewRows} 行` : '—'}；步长单位小时，必须 ≤ 模拟时长。
                </p>
                <button className="button button--quiet" type="button" onClick={applySampleParameters}>填入示例参数（合成数据）</button>
              </>
            )}

            {selectedMethod === 'growth_fit' && (
              <label className="modeling-field">
                输入数据集
                <select value={datasetId} onChange={event => setDatasetId(event.target.value)}>
                  <option value="">选择 time/biomass CSV</option>
                  {datasets.map(dataset => (
                    <option key={dataset.id} value={dataset.id}>{dataset.name} · {dataset.rowCount} 行</option>
                  ))}
                </select>
              </label>
            )}
            {selectedMethod === 'growth_fit' && (
              <div className="modeling-note">
                拟合假定所有输入点都处于同一指数生长期、无滞后或平台期。阶段选择由操作者负责；rSquared/logRmse 是拟合诊断，不是不确定度。
              </div>
            )}

            <div className="modeling-form-grid">
              <label className="modeling-field">
                任务标题（可选）
                <input value={title} maxLength={100} onChange={event => setTitle(event.target.value)} placeholder="便于在任务记录中识别" />
              </label>
              <label className="modeling-field">
                最长运行时间
                <select value={budgetSeconds} onChange={event => setBudgetSeconds(Number(event.target.value))}>
                  {BUDGET_OPTIONS.map(seconds => <option key={seconds} value={seconds}>{seconds} 秒</option>)}
                </select>
              </label>
            </div>
            <button
              className="button button--primary"
              disabled={mutationBusy || !runId || methods.length === 0 || (selectedMethod === 'growth_fit' && !datasetId)}
              onClick={() => void submitTask()}
            >
              {pending.has('submit') ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />} 提交任务
            </button>
          </article>

          {initialLoading && <article className="modeling-card"><div className="modeling-empty"><LoaderCircle className="spin" size={14} /> 正在读取方法与任务…</div></article>}

          {activeTask && resultMatchesActive && result && (
            <ModelingResultPanel
              client={client}
              task={activeTask}
              method={methods.find(method => method.id === activeTask.method)}
              result={result}
              datasetName={datasets.find(dataset => dataset.id === activeTask.datasetId)?.name}
              maxExperimentNote={maxExperimentNote}
              prediction={{
                id: predictionId,
                text: predictionText,
                conditions: conditionsText,
                uncertainty: uncertaintyText,
                onText: setPredictionText,
                onConditions: setConditionsText,
                onUncertainty: setUncertaintyText,
              }}
              experiment={{
                reference: experimentReference,
                note: experimentNote,
                linked: linkedExperiment,
                onReference: setExperimentReference,
                onNote: setExperimentNote,
              }}
              pending={pending}
              onRegister={() => void registerPrediction()}
              onLink={() => void linkExperimentTask()}
            />
          )}

          {activeTask && !resultMatchesActive && (
            <article className="modeling-card" data-testid="modeling-result-status">
              <h2>任务结果</h2>
              {resultLoading && <div className="modeling-empty"><LoaderCircle className="spin" size={13} /> 正在读取任务 {activeTask.id} 的结果…</div>}
              {!resultLoading && resultError && <div className="modeling-alert modeling-alert--error" role="alert">{resultError}</div>}
              {!resultLoading && !resultError && (
                <div className="modeling-empty">
                  {activeTask.status === 'FAILED' || activeTask.status === 'TIMED_OUT'
                    ? `任务未成功（${statusLabel(activeTask.status)}），没有可展示的结果。`
                    : activeTask.status === 'SUCCEEDED'
                      ? '结果尚未载入。'
                      : `任务状态：${statusLabel(activeTask.status)}。完成后会自动载入结果。`}
                </div>
              )}
              {activeTask.error && <div className="modeling-alert modeling-alert--error" role="alert">{activeTask.error}</div>}
              {activeTask.status === 'SUCCEEDED' && !resultLoading && !resultError && (
                <button className="button button--quiet" onClick={() => void loadResult(activeTask.id, generationRef.current)}>重新载入结果</button>
              )}
            </article>
          )}
        </div>

        <aside className="modeling-side">
          <article className="modeling-card">
            <h2>任务记录 <span>{tasks.length}</span></h2>
            {tasks.length === 0
              ? <div className="modeling-empty">当前运行还没有计算任务。</div>
              : tasks.map(task => (
                <div className={`modeling-task-row ${activeTaskId === task.id ? 'is-active' : ''}`} key={task.id}>
                  <button className="modeling-task" onClick={() => selectTask(task)} aria-pressed={activeTaskId === task.id}>
                    <strong>{task.title || task.method}</strong>
                    <span className={`modeling-status modeling-status--${task.status.toLowerCase()}`}>{statusLabel(task.status)}</span>
                    <small>{new Date(task.createdAt).toLocaleString()} · {task.method} · {task.methodVersion}</small>
                    {task.error && <small className="modeling-task-error">{task.error}</small>}
                    {task.predictionId && <small>预测：{task.predictionId}</small>}
                    {task.linkedExperiment && <small>实验引用：{task.linkedExperiment}（PROPOSED）</small>}
                  </button>
                  {!isTerminal(task.status) && (
                    <button
                      className="button button--quiet modeling-task-cancel"
                      disabled={mutationBusy}
                      onClick={() => void cancelTask(task)}
                    >
                      {pending.has(`cancel:${task.id}`) ? <LoaderCircle className="spin" size={12} /> : null} 取消
                    </button>
                  )}
                </div>
              ))}
          </article>

          <article className="modeling-card">
            <h2>科学边界</h2>
            <ul>
              <li>参数必须与实验体系的单位一致：Monod 使用 h、g/L、1/h 与 g-biomass/g-substrate。</li>
              <li>Monod 模拟是理想化预测，质量守恒 X + Y·S；不包含维护、死亡、抑制、补料或产物形成。</li>
              <li>增长拟合假定指数期；阶段筛选由使用者负责，拟合不能证明机制或外推有效。</li>
              <li>模型预测不能替代测量；关联实验只是引用，不代表已测试或已确认。</li>
            </ul>
          </article>
        </aside>
      </div>
    </section>
  )
}
