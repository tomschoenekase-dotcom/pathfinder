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
  },
}
