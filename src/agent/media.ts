/** Image payloads travel separately from bounded, textual tool observations. */
export interface ModelImage {
  dataUrl: string
  label: string
}

export const MAX_MODEL_IMAGES = 6
export const IMAGE_TOKEN_ESTIMATE = 2048

export interface VisualToolResult {
  observation: Record<string, unknown>
  images: ModelImage[]
}

export function isVisualToolResult(value: unknown): value is VisualToolResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<VisualToolResult>
  return !!result.observation && Array.isArray(result.images)
    && result.images.every(image => typeof image.label === 'string'
      && /^data:image\/(png|jpeg|webp);base64,/.test(image.dataUrl))
}
