import { describe, expect, it } from 'vitest'

import {
  decideGuestGeneralWebSearch,
  GUEST_GENERAL_WEB_QUERY_MAX_CHARACTERS,
} from './guest-general-web-policy'

const eligible = {
  globalEnabled: true,
  tenantEnabled: true,
  providerAvailable: true,
  localContextSufficient: false,
} as const

describe('guest general web policy', () => {
  it.each([
    [{}, 'GLOBAL_DISABLED'],
    [{ globalEnabled: true }, 'TENANT_DISABLED'],
    [{ globalEnabled: true, tenantEnabled: true }, 'PROVIDER_UNAVAILABLE'],
    [{ ...eligible, localContextSufficient: true }, 'LOCAL_CONTEXT_SUFFICIENT'],
  ] as const)('fails closed when the %s server capability is absent', (input, reason) => {
    expect(decideGuestGeneralWebSearch({ ...input, query: 'What is photosynthesis?' })).toEqual({
      kind: 'SKIP',
      reason,
    })
  })

  it.each([
    ['what is your closing time?', 'VENUE_OR_OPERATIONAL_REQUEST'],
    ['how does wheelchair access work here?', 'VENUE_OR_OPERATIONAL_REQUEST'],
    ['why are tickets expensive?', 'VENUE_OR_OPERATIONAL_REQUEST'],
    ['tell me about your safety policy', 'VENUE_OR_OPERATIONAL_REQUEST'],
    ['¿Qué es la fotosíntesis?', 'UNKNOWN_OR_AMBIGUOUS_INTENT'],
    ['what is 博物館?', 'UNSUPPORTED_SCRIPT'],
  ])('keeps venue-sensitive and non-English ambiguous queries local', (query, reason) => {
    expect(decideGuestGeneralWebSearch({ ...eligible, query })).toEqual({ kind: 'SKIP', reason })
  })

  it('allows only a bounded general English intent and normalizes Unicode whitespace', () => {
    expect(
      decideGuestGeneralWebSearch({ ...eligible, query: '  What\u00a0is\u00a0photosynthèse?  ' }),
    ).toEqual({ kind: 'SEARCH', normalizedQuery: 'What is photosynthèse?' })
  })

  it('rejects blank and overlong queries before any background search is eligible', () => {
    expect(decideGuestGeneralWebSearch({ ...eligible, query: ' \n\t ' })).toEqual({
      kind: 'SKIP',
      reason: 'EMPTY_QUERY',
    })
    expect(
      decideGuestGeneralWebSearch({
        ...eligible,
        query: `What is ${'a'.repeat(GUEST_GENERAL_WEB_QUERY_MAX_CHARACTERS)}?`,
      }),
    ).toEqual({ kind: 'SKIP', reason: 'QUERY_TOO_LONG' })
  })

  it.each([
    ['What is photosynthesis? https://example.test/guide', 'EMBEDDED_DESTINATION'],
    ['What is photosynthesis? contact@example.test', 'EMBEDDED_DESTINATION'],
    ['What is\u0001photosynthesis?', 'CONTROL_CHARACTER'],
  ])('does not send embedded destinations or controls to background search', (query, reason) => {
    expect(decideGuestGeneralWebSearch({ ...eligible, query })).toEqual({ kind: 'SKIP', reason })
  })
})
