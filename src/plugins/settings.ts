import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_ENABLED_PLUGINS, MANAGED_PLUGIN_IDS, type PluginId } from './types.js'

export function readEnabledPlugins(path: string): PluginId[] {
  try {
    const saved: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(saved) && saved.every(id => MANAGED_PLUGIN_IDS.includes(id))) {
      return [...new Set(saved)] as PluginId[]
    }
  } catch { /* First run or invalid settings: use the bundled defaults. */ }
  return [...DEFAULT_ENABLED_PLUGINS]
}

export function saveEnabledPlugins(path: string, ids: PluginId[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(ids), { mode: 0o600 })
}
