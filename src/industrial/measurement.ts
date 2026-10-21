import type { ProcessParameter } from './types.js'

const PLAUSIBLE_UNIT = /^(?:%|[\p{L}°µμ][\p{L}\p{N}%°µμ/·^.\- ]{0,15})$/u

export function resolveMeasurementUnit(parameter: ProcessParameter, raw: unknown): string {
  let provided = ''
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'string') throw new Error('单位 unit 必须是字符串。')
    provided = raw.trim()
  }
  const declared = parameter.unit.trim()
  if (provided && declared && provided !== declared) {
    throw new Error(`测量单位「${provided}」与参数「${parameter.key}」定义的单位「${declared}」不一致。`)
  }
  const unit = provided || declared
  if (!unit) throw new Error(`参数「${parameter.key}」未定义单位，记录测量值必须明确提供单位，不能留空。`)
  if (!declared && provided && !PLAUSIBLE_UNIT.test(provided)) {
    throw new Error(`测量单位「${provided}」不是可识别的单位写法，拒绝写入。`)
  }
  return unit
}
