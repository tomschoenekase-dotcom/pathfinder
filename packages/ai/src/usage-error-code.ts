const exactAiUsageErrorCodes = new Set([
  'AbortError',
  'TimeoutError',
  'invalid-provider-response',
  'invalid-structured-output',
  'missing-text-block',
  'provider-AbortError',
  'provider-TimeoutError',
  'provider-client-initialization',
  'provider-connection-error',
  'provider-connection-timeout',
  'provider-error',
  'provider-file-delete-unconfirmed',
  'provider-incomplete-response',
  'provider-not-configured',
  'provider-timeout',
  'provider-user-abort',
] as const)

export type AiUsageErrorCode =
  | (typeof exactAiUsageErrorCodes extends Set<infer Code> ? Code : never)
  | `provider-http-${number}`

export function normalizeAiUsageErrorCode(code: string | undefined): AiUsageErrorCode | undefined {
  if (!code) return undefined
  if (exactAiUsageErrorCodes.has(code as never)) return code as AiUsageErrorCode
  if (/^provider-http-[1-5]\d{2}$/u.test(code)) return code as `provider-http-${number}`
  return 'provider-error'
}
