type EnvironmentLike = Record<string, string | undefined>

type StackFrame = Record<string, unknown>

type MonitoringException = Record<string, unknown> & {
  stacktrace?: {
    frames?: StackFrame[]
  }
  type?: string
  value?: string
}

export type MonitoringEvent = Record<string, unknown> & {
  breadcrumbs?: unknown
  contexts?: unknown
  environment?: string
  event_id?: string
  exception?: {
    values?: MonitoringException[]
  }
  extra?: unknown
  fingerprint?: string[]
  message?: string
  level?: string
  platform?: string
  release?: string
  request?: unknown
  tags?: Record<string, unknown>
  transaction?: string
  user?: unknown
}

export type MonitoringContext = {
  enabled: boolean
  environment: string
  release: string
  service: string
}

const SAFE_VALUE = /^[a-zA-Z0-9._/-]+$/
const SAFE_ACTION = /^[a-z][a-z0-9.-]{1,79}$/
const SAFE_CODE_LOCATION =
  /^(?:\.next\/|apps\/|dist\/|node:[a-zA-Z0-9_./-]+$|packages\/|src\/|webpack-internal:\/\/\/)/
const SAFE_EVENT_ID = /^[a-f0-9]{32}$/i
const SAFE_LEVELS = new Set(['debug', 'error', 'fatal', 'info', 'warning'])
const MAX_METADATA_LENGTH = 100
const GENERIC_ERROR_MESSAGE = 'Application error'
const SAFE_TAGS = new Set(['action', 'environment', 'release', 'service'])

const safeMetadata = (value: string | undefined, fallback: string): string => {
  const normalized = value?.trim()
  if (!normalized || normalized.length > MAX_METADATA_LENGTH || !SAFE_VALUE.test(normalized)) {
    return fallback
  }
  return normalized
}

export const resolveMonitoringContext = (
  environment: EnvironmentLike,
  service: string,
  publicRuntime = false,
): MonitoringContext => {
  const enabledKey = publicRuntime ? 'NEXT_PUBLIC_SENTRY_ENABLED' : 'SENTRY_ENABLED'
  const dsnKey = publicRuntime ? 'NEXT_PUBLIC_SENTRY_DSN' : 'SENTRY_DSN'
  const environmentValue = publicRuntime
    ? (environment.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? environment.NODE_ENV)
    : (environment.RAILWAY_ENVIRONMENT ?? environment.NODE_ENV)
  const releaseValue = publicRuntime
    ? environment.NEXT_PUBLIC_SENTRY_RELEASE
    : (environment.SENTRY_RELEASE ??
      environment.RAILWAY_GIT_COMMIT_SHA ??
      environment.VERCEL_GIT_COMMIT_SHA ??
      environment.GITHUB_SHA)

  return {
    enabled: environment[enabledKey] === 'true' && Boolean(environment[dsnKey]?.trim()),
    environment: safeMetadata(environmentValue, 'unknown'),
    release: safeMetadata(releaseValue, 'unknown'),
    service: safeMetadata(service, 'pathfinder'),
  }
}

const sanitizeFrame = (frame: StackFrame): StackFrame => {
  const sanitized: StackFrame = {}
  for (const key of ['colno', 'in_app', 'lineno']) {
    const value = frame[key]
    if (typeof value === 'number' || typeof value === 'boolean') sanitized[key] = value
  }
  for (const key of ['function', 'module']) {
    const value = frame[key]
    if (typeof value === 'string' && value.length <= 200 && SAFE_VALUE.test(value)) {
      sanitized[key] = value
    }
  }
  const filename = frame.filename
  if (
    typeof filename === 'string' &&
    filename.length <= 500 &&
    !filename.includes('?') &&
    !filename.includes('#') &&
    !filename.includes('..') &&
    !filename.includes('\\') &&
    SAFE_CODE_LOCATION.test(filename)
  ) {
    sanitized.filename = filename
  }
  return sanitized
}

const sanitizeException = (exception: MonitoringException): MonitoringException => ({
  type: 'Error',
  value: GENERIC_ERROR_MESSAGE,
  ...(exception.stacktrace?.frames
    ? {
        stacktrace: {
          frames: exception.stacktrace.frames.map(sanitizeFrame),
        },
      }
    : {}),
})

/**
 * Last-line privacy boundary for error monitoring. Request data, identity,
 * breadcrumbs and arbitrary context are removed even if an SDK integration
 * collected them. Exception locations remain useful, while messages and code
 * context are discarded because provider errors can echo customer content.
 */
export const sanitizeMonitoringEvent = <T extends object>(event: T): T => {
  const source = event as unknown as MonitoringEvent
  const tags = Object.fromEntries(
    Object.entries(source.tags ?? {}).flatMap(([key, value]) => {
      if (!SAFE_TAGS.has(key) || typeof value !== 'string') return []
      const safe = safeMetadata(value, '')
      if (key === 'action' && !SAFE_ACTION.test(safe)) return []
      return safe ? [[key, safe]] : []
    }),
  )

  const fingerprint =
    source.fingerprint?.[0] === 'handled-error' &&
    tags.action &&
    source.fingerprint[1] === tags.action
      ? ['handled-error', String(tags.action)]
      : undefined

  // Positive allow-list: adding a field to an SDK event never makes it eligible
  // for transport unless it is deliberately copied here.
  const sanitized: MonitoringEvent = {}
  if (source.event_id && SAFE_EVENT_ID.test(source.event_id)) {
    sanitized.event_id = source.event_id
  }
  if (typeof source.timestamp === 'number' && Number.isFinite(source.timestamp)) {
    sanitized.timestamp = source.timestamp
  }
  if (source.platform) sanitized.platform = safeMetadata(source.platform, 'javascript')
  if (source.level && SAFE_LEVELS.has(source.level)) sanitized.level = source.level
  if (source.environment) sanitized.environment = safeMetadata(source.environment, 'unknown')
  if (source.release) sanitized.release = safeMetadata(source.release, 'unknown')
  if (Object.keys(tags).length > 0) sanitized.tags = tags
  if (fingerprint) sanitized.fingerprint = fingerprint
  if (source.message !== undefined) sanitized.message = GENERIC_ERROR_MESSAGE
  if (source.exception?.values) {
    sanitized.exception = { values: source.exception.values.map(sanitizeException) }
  }

  return sanitized as unknown as T
}

export const monitoringErrorMessage = GENERIC_ERROR_MESSAGE
