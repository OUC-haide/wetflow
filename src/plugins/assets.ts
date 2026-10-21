import { fileURLToPath } from 'node:url'

export function educationSourcesDirectory(): string {
  return fileURLToPath(new URL('../../examples/education/sources/', import.meta.url))
}
