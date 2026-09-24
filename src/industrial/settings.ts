import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConnectorMode } from './types.js'

export interface IndustrialSettings {
  database: {
    driver: 'sqlite'
    path: string
  }
  api: {
    defaultMode: ConnectorMode
    requestTimeoutMs: number
    allowInsecureHttp: boolean
  }
}

export interface PublicIndustrialSettings extends IndustrialSettings {
  settingsPath: string
  restartRequired: boolean
  activeDatabasePath: string
  executionWritesEnabled: false
}

const DEFAULT_SETTINGS: IndustrialSettings = {
  database: { driver: 'sqlite', path: '.wetflow/industrial.db' },
  api: { defaultMode: 'READ_ONLY', requestTimeoutMs: 10_000, allowInsecureHttp: false },
}

function databasePath(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.database.path
  const normalized = value.trim()
  if (!normalized || normalized.length > 500 || normalized.includes('\0')) throw new Error('工业数据库路径无效。')
  return normalized
}

function timeout(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error('API 超时时间必须在 1000 到 120000 毫秒之间。')
  }
  return parsed
}

function mode(value: unknown): ConnectorMode {
  if (value !== 'READ_ONLY' && value !== 'PROPOSE' && value !== 'CONTROLLED') {
    throw new Error('API 默认模式必须是 READ_ONLY、PROPOSE 或 CONTROLLED。')
  }
  return value
}

export class IndustrialSettingsManager {
  private settings: IndustrialSettings
  private restartRequired = false

  constructor(
    readonly path: string,
    private readonly activeDatabasePath: string,
  ) {
    this.settings = this.read()
  }

  current(): IndustrialSettings {
    return structuredClone(this.settings)
  }

  public(): PublicIndustrialSettings {
    return {
      ...this.current(),
      settingsPath: this.path,
      restartRequired: this.restartRequired,
      activeDatabasePath: this.activeDatabasePath,
      executionWritesEnabled: false,
    }
  }

  update(input: Partial<IndustrialSettings>): PublicIndustrialSettings {
    if (input.database?.driver !== undefined && input.database.driver !== 'sqlite') {
      throw new Error('当前版本只支持 SQLite 工业数据库。')
    }
    const next: IndustrialSettings = {
      database: {
        driver: 'sqlite',
        path: databasePath(input.database?.path ?? this.settings.database.path),
      },
      api: {
        defaultMode: mode(input.api?.defaultMode ?? this.settings.api.defaultMode),
        requestTimeoutMs: timeout(input.api?.requestTimeoutMs ?? this.settings.api.requestTimeoutMs),
        allowInsecureHttp: input.api?.allowInsecureHttp ?? this.settings.api.allowInsecureHttp,
      },
    }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(this.path, 0o600) } catch { /* Windows may ignore POSIX modes. */ }
    this.settings = next
    this.restartRequired = next.database.path !== this.activeDatabasePath
    return this.public()
  }

  private read(): IndustrialSettings {
    if (!existsSync(this.path)) return structuredClone(DEFAULT_SETTINGS)
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<IndustrialSettings>
      return {
        database: {
          driver: 'sqlite',
          path: databasePath(parsed.database?.path),
        },
        api: {
          defaultMode: mode(parsed.api?.defaultMode ?? DEFAULT_SETTINGS.api.defaultMode),
          requestTimeoutMs: timeout(parsed.api?.requestTimeoutMs ?? DEFAULT_SETTINGS.api.requestTimeoutMs),
          allowInsecureHttp: parsed.api?.allowInsecureHttp ?? DEFAULT_SETTINGS.api.allowInsecureHttp,
        },
      }
    } catch {
      return structuredClone(DEFAULT_SETTINGS)
    }
  }
}

