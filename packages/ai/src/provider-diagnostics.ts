/** Deliberately bounded metadata: never inspect messages, headers or request bodies. */
export type SafeProviderCode =
  | 'insufficient_quota'
  | 'credit_balance_exhausted'
  | 'rate_limit_exceeded'
  | 'rate_limit_error'
  | 'overloaded_error'
  | 'server_error'
  | 'authentication_error'
  | 'invalid_api_key'

export type ProviderFailureCode =
  | 'PROVIDER_CREDITS_EXHAUSTED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_AUTHENTICATION_FAILED'
  | 'PROVIDER_CONNECTION_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNKNOWN'

export type ProviderDiagnostics = {
  code: ProviderFailureCode
  httpStatus: number | null
  providerCode: SafeProviderCode | null
  retryable: boolean
}

const safeCodes = new Set<string>([
  'insufficient_quota',
  'credit_balance_exhausted',
  'rate_limit_exceeded',
  'rate_limit_error',
  'overloaded_error',
  'server_error',
  'authentication_error',
  'invalid_api_key',
])

function field(value: object, key: string): unknown {
  // A hostile exception may contain accessors. Do not execute them during diagnostics.
  try {
    let current: object | null = value
    for (let depth = 0; current && depth < 4; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined
      current = Object.getPrototypeOf(current) as object | null
    }
  } catch {
    /* Unreadable metadata is unknown. */
  }
  return undefined
}

export function classifyProviderFailure(error: unknown): ProviderDiagnostics {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }]
  const seen = new Set<object>()
  let httpStatus: number | null = null
  let providerCode: SafeProviderCode | null = null
  const codes = new Set<string>()
  const names = new Set<string>()
  for (let visited = 0; pending.length && visited < 16; visited += 1) {
    const entry = pending.shift()!
    if (!entry.value || typeof entry.value !== 'object' || seen.has(entry.value)) continue
    seen.add(entry.value)
    const status = field(entry.value, 'status')
    if (
      httpStatus === null &&
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    )
      httpStatus = status
    for (const key of ['code', 'type']) {
      const code = field(entry.value, key)
      if (typeof code === 'string') {
        codes.add(code)
        if (
          safeCodes.has(code) &&
          (providerCode === null ||
            code === 'insufficient_quota' ||
            code === 'credit_balance_exhausted')
        )
          providerCode = code as SafeProviderCode
      }
    }
    const name = field(entry.value, 'name')
    if (typeof name === 'string') names.add(name)
    if (entry.depth < 4) {
      for (const key of ['cause', 'error'])
        pending.push({ value: field(entry.value, key), depth: entry.depth + 1 })
    }
  }
  let code: ProviderFailureCode = 'PROVIDER_UNKNOWN'
  if (
    codes.has('insufficient_quota') ||
    codes.has('credit_balance_exhausted') ||
    codes.has('PROVIDER_CREDITS_EXHAUSTED')
  )
    code = 'PROVIDER_CREDITS_EXHAUSTED'
  else if (
    codes.has('provider-not-configured') ||
    codes.has('provider-client-initialization') ||
    codes.has('PROVIDER_NOT_CONFIGURED')
  )
    code = 'PROVIDER_NOT_CONFIGURED'
  else if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    codes.has('invalid_api_key') ||
    codes.has('authentication_error') ||
    codes.has('PROVIDER_AUTHENTICATION_FAILED')
  )
    code = 'PROVIDER_AUTHENTICATION_FAILED'
  else if (
    httpStatus === 429 ||
    codes.has('rate_limit_exceeded') ||
    codes.has('rate_limit_error') ||
    codes.has('PROVIDER_RATE_LIMITED')
  )
    code = 'PROVIDER_RATE_LIMITED'
  else if (
    (httpStatus !== null && httpStatus >= 500) ||
    codes.has('overloaded_error') ||
    codes.has('server_error') ||
    codes.has('PROVIDER_UNAVAILABLE')
  )
    code = 'PROVIDER_UNAVAILABLE'
  else if (
    httpStatus === 408 ||
    names.has('APIConnectionTimeoutError') ||
    names.has('TimeoutError') ||
    codes.has('provider-timeout') ||
    codes.has('provider-connection-timeout') ||
    codes.has('PROVIDER_TIMEOUT')
  )
    code = 'PROVIDER_TIMEOUT'
  else if (
    names.has('APIConnectionError') ||
    codes.has('provider-connection-error') ||
    codes.has('PROVIDER_CONNECTION_FAILED')
  )
    code = 'PROVIDER_CONNECTION_FAILED'
  return {
    code,
    httpStatus,
    providerCode,
    retryable: [
      'PROVIDER_RATE_LIMITED',
      'PROVIDER_UNAVAILABLE',
      'PROVIDER_TIMEOUT',
      'PROVIDER_CONNECTION_FAILED',
    ].includes(code),
  }
}
