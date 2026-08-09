export type PublicVenueLookupFailure = 'not-found' | 'temporarily-unavailable' | 'other'

/**
 * Works with both server-side TRPCError objects and browser TRPCClientError
 * objects without coupling public UI code to either error implementation.
 */
export function classifyPublicVenueLookupError(error: unknown): PublicVenueLookupFailure {
  if (!error || typeof error !== 'object') {
    return 'other'
  }

  const record = error as { code?: unknown; data?: { code?: unknown } }
  const code = typeof record.code === 'string' ? record.code : record.data?.code

  if (code === 'NOT_FOUND') {
    return 'not-found'
  }

  if (code === 'SERVICE_UNAVAILABLE') {
    return 'temporarily-unavailable'
  }

  return 'other'
}
