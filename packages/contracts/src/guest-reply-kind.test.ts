import { describe, expect, it } from 'vitest'

import { guestReplyKindFromFallbackCode } from './guest-reply-kind'

describe('guest reply presentation kind', () => {
  it.each([null, undefined, 'NO_RELEVANT_CONTEXT'])('keeps %s as an answer', (code) => {
    expect(guestReplyKindFromFallbackCode(code)).toBe('ANSWER')
  })

  it.each([
    'PROVIDER_CONFIGURATION_REQUIRED',
    'PROVIDER_CONNECTION_FAILED',
    'PROVIDER_REQUEST_ABORTED',
    'PROVIDER_INVALID_RESPONSE',
    'PROVIDER_REQUEST_FAILED',
    'UNEXPECTED_FAILURE',
    'FUTURE_FAILURE',
  ])('projects %s without exposing the internal code', (code) => {
    expect(guestReplyKindFromFallbackCode(code)).toBe('TEMPORARY_FALLBACK')
  })
})
