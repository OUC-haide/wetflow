export const DEFAULT_CONTEXT_TOKEN_BUDGET = 128_000
export const MIN_CONTEXT_TOKEN_BUDGET = 1_024
export const MAX_CONTEXT_TOKEN_BUDGET = 1_000_000

export function isContextTokenBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_CONTEXT_TOKEN_BUDGET && value <= MAX_CONTEXT_TOKEN_BUDGET
}
