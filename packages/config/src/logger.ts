export type LogFields = {
  action: string
  tenantId?: string
  userId?: string
  [key: string]: unknown
}

type LoggerMethodFields = LogFields & {
  error?: string
  stack?: string
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type ErrorMonitor = (fields: Readonly<LoggerMethodFields>) => void

const ERROR_MONITOR_KEY = Symbol.for('pathfinder.error-monitor')

type ErrorMonitorState = {
  sink: ErrorMonitor | undefined
}

const errorMonitorState = (): ErrorMonitorState => {
  const globalState = globalThis as typeof globalThis & {
    [ERROR_MONITOR_KEY]?: ErrorMonitorState
  }
  globalState[ERROR_MONITOR_KEY] ??= { sink: undefined }
  return globalState[ERROR_MONITOR_KEY]
}

const SERVICE_NAME = 'pathfinder'
const REDACTED = '[redacted]'
const CIRCULAR = '[circular]'
const MAX_DEPTH = 4
const MAX_COLLECTION_SIZE = 64
const MAX_TOTAL_VALUES = 256
const SAFE_ACTION = /^[a-z0-9][a-z0-9._:-]{0,127}$/u
const SAFE_METADATA = /^[a-z0-9][a-z0-9._:/-]{0,255}$/iu
const SECRET_KEY = /(authorization|cookie|credential|password|secret|token|api[-_]?key|dsn)/iu
const CONTENT_KEY =
  /^(answer|body|comment|content|description|detail|email|filename|message|name|notes|output|phone|prompt|query|reason|recipient|request|response|stack|subject|text|url)$/iu
const SAFE_METADATA_KEY =
  /(action|attempt|bytes|capability|category|code|count|digest|duration|enabled|environment|hash|host|id|ids|job|kind|level|limit|mode|model|provider|queue|release|result|scope|service|stage|state|status|type|version)$/iu

function sanitizedString(key: string, value: string): string {
  if (key.toLowerCase() === 'error') return REDACTED
  if (SECRET_KEY.test(key) || CONTENT_KEY.test(key)) return REDACTED
  if (!SAFE_METADATA_KEY.test(key) || !SAFE_METADATA.test(value)) return REDACTED
  return value
}

function sanitizedValue(
  key: string,
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
  budget: { remaining: number },
): unknown {
  if (budget.remaining <= 0) return '[truncated]'
  budget.remaining -= 1
  if (key.toLowerCase() === 'error' || SECRET_KEY.test(key) || CONTENT_KEY.test(key)) {
    return REDACTED
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : REDACTED
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return sanitizedString(key, value)
  if (typeof value !== 'object' || depth >= MAX_DEPTH) return REDACTED
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return REDACTED
  if (ancestors.has(value)) return CIRCULAR

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_COLLECTION_SIZE)
        .map((item) => sanitizedValue(key, item, depth + 1, ancestors, budget))
      if (value.length > MAX_COLLECTION_SIZE) items.push('[truncated]')
      return items
    }

    const output: Record<string, unknown> = {}
    const entries = Object.entries(value).slice(0, MAX_COLLECTION_SIZE)
    for (const [nestedKey, nestedValue] of entries) {
      output[nestedKey] = sanitizedValue(nestedKey, nestedValue, depth + 1, ancestors, budget)
    }
    if (Object.keys(value).length > MAX_COLLECTION_SIZE) output.truncated = true
    return output
  } finally {
    ancestors.delete(value)
  }
}

function sanitizeLogFields(fields: LoggerMethodFields): LoggerMethodFields {
  const sanitized: LoggerMethodFields = {
    action: SAFE_ACTION.test(fields.action) ? fields.action : 'invalid-action',
  }
  const ancestors = new WeakSet<object>()
  const budget = { remaining: MAX_TOTAL_VALUES }
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'action') continue
    sanitized[key] = sanitizedValue(key, value, 0, ancestors, budget)
  }
  return sanitized
}

function safelySanitizeLogFields(fields: LoggerMethodFields): LoggerMethodFields {
  try {
    return sanitizeLogFields(fields)
  } catch {
    return {
      action: 'sanitization-failed',
      sanitization: 'failed',
    }
  }
}

const writeLog = (level: LogLevel, fields: LoggerMethodFields): LoggerMethodFields => {
  const sanitizedFields = safelySanitizeLogFields(fields)
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    ...sanitizedFields,
  }

  process.stdout.write(`${JSON.stringify(payload)}\n`)
  return sanitizedFields
}

export const logger = {
  debug(fields: LogFields): void {
    writeLog('debug', fields)
  },
  info(fields: LogFields): void {
    writeLog('info', fields)
  },
  warn(fields: LogFields & { error?: string }): void {
    writeLog('warn', fields)
  },
  error(fields: LogFields & { error: string; stack?: string }): void {
    const sanitizedFields = writeLog('error', fields)
    try {
      errorMonitorState().sink?.(sanitizedFields)
    } catch {
      // Observability must never alter the application failure path.
    }
  },
}

export const setErrorMonitor = (sink?: ErrorMonitor): void => {
  errorMonitorState().sink = sink
}
