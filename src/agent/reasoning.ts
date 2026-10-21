export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max'

export interface ReasoningConfig {
  efforts: Array<{ id: ReasoningEffort; label: string; description: string }>
  defaultEffort: ReasoningEffort
}

export const GENERIC_REASONING: ReasoningConfig = {
  efforts: [
    { id: 'low', label: '低', description: '响应更快' },
    { id: 'medium', label: '中', description: '速度与推理平衡' },
    { id: 'high', label: '高', description: '更充分地推理' },
  ],
  defaultEffort: 'medium',
}

export const DEEPSEEK_REASONING: ReasoningConfig = {
  efforts: [
    { id: 'off', label: '关闭', description: '不启用思考' },
    { id: 'low', label: '低', description: '较少思考' },
    { id: 'high', label: '高', description: '充分思考' },
    { id: 'max', label: '最高', description: '最大思考强度' },
  ],
  defaultEffort: 'high',
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && ['off', 'low', 'medium', 'high', 'max'].includes(value)
}

export function isDeepSeekModel(model: string): boolean {
  return /^deepseek-(?:flash|v4(?:[-.].+)?|chat|reasoner)$/i.test(model.split('/').at(-1) ?? '')
}

export function reasoningConfig(model: string): ReasoningConfig {
  return isDeepSeekModel(model) ? DEEPSEEK_REASONING : GENERIC_REASONING
}

/** DeepSeek Chat Completions uses a thinking toggle as well as effort.
 * https://api-docs.deepseek.com/guides/thinking_mode/
 */
export function reasoningParameters(model: string, requested?: ReasoningEffort): Record<string, unknown> {
  if (isDeepSeekModel(model)) {
    // Migrate the former generic 'medium' selection using DeepSeek's documented mapping.
    const effort = requested === 'medium' ? 'high' : requested ?? 'high'
    if (effort === 'off') return { thinking: { type: 'disabled' } }
    return { thinking: { type: 'enabled' }, reasoning_effort: effort }
  }
  if (requested === undefined) return {}
  if (!GENERIC_REASONING.efforts.some(item => item.id === requested)) {
    throw new Error(`当前模型未配置 ${requested} 思考档位，请选择低、中或高。`)
  }
  return { reasoning_effort: requested }
}
