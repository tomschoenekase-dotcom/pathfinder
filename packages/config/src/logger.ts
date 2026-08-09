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

const writeLog = (level: LogLevel, fields: LoggerMethodFields): void => {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    ...fields,
  }

  process.stdout.write(`${JSON.stringify(payload)}\n`)
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
    writeLog('error', fields)
    try {
      errorMonitorState().sink?.(fields)
    } catch {
      // Observability must never alter the application failure path.
    }
  },
}

export const setErrorMonitor = (sink?: ErrorMonitor): void => {
  errorMonitorState().sink = sink
}
