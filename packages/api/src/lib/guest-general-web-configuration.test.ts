import { describe, expect, it, vi } from 'vitest'

import {
  GUEST_GENERAL_WEB_TENANT_FLAG_KEY,
  resolveGuestGeneralWebConfiguration,
} from './guest-general-web-configuration'

const findUnique = vi.fn()
const client = { tenantFeatureFlag: { findUnique } }
const input = { tenantId: 'tenant-a', venueId: 'venue-a', globalEnabled: true }

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    venueIds: ['venue-a'],
    allowedDomains: ['science.example.org'],
    modelKey: 'guest-chat-openai',
    maxOutputTokens: 512,
    timeoutMs: 4_000,
    requestBudgetCeilingE8Usd: '25000',
    ...overrides,
  }
}

describe('guest general web configuration', () => {
  it('returns null without a global capability and does not read tenant state', async () => {
    await expect(
      resolveGuestGeneralWebConfiguration({ tenantId: 'tenant-a', venueId: 'venue-a' }, client),
    ).resolves.toBeNull()
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('uses an exact tenant and flag-key lookup, then freezes the bounded configuration', async () => {
    findUnique.mockResolvedValueOnce({ enabled: true, metadata: metadata() })

    const resolved = await resolveGuestGeneralWebConfiguration(input, client)

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_flagKey: {
          tenantId: 'tenant-a',
          flagKey: GUEST_GENERAL_WEB_TENANT_FLAG_KEY,
        },
      },
      select: { enabled: true, metadata: true },
    })
    expect(resolved).toEqual({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      allowedDomains: ['science.example.org'],
      modelKey: 'guest-chat-openai',
      maxOutputTokens: 512,
      timeoutMs: 4_000,
      requestBudgetCeilingE8Usd: '25000',
      maxResults: 3,
      maxToolCalls: 1,
    })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved?.allowedDomains)).toBe(true)
  })

  it.each([
    ['wrong tenant', { tenantId: 'tenant-other', venueId: 'venue-a', globalEnabled: true }, null],
    ['disabled flag', input, { enabled: false, metadata: metadata() }],
    ['revoked flag', input, null],
    [
      'wrong venue admission',
      input,
      { enabled: true, metadata: metadata({ venueIds: ['venue-b'] }) },
    ],
    ['malformed metadata', input, { enabled: true, metadata: metadata({ timeoutMs: 5_001 }) }],
    [
      'non-integer E8 budget metadata',
      input,
      { enabled: true, metadata: metadata({ requestBudgetCeilingE8Usd: '0.00025000' }) },
    ],
    [
      'unsafe domain metadata',
      input,
      { enabled: true, metadata: metadata({ allowedDomains: ['127.0.0.1'] }) },
    ],
  ] as const)(
    'fails closed for %s without inventing tenant permission',
    async (_case, exactInput, row) => {
      findUnique.mockResolvedValueOnce(row)
      await expect(resolveGuestGeneralWebConfiguration(exactInput, client)).resolves.toBeNull()
      expect(findUnique).toHaveBeenLastCalledWith({
        where: {
          tenantId_flagKey: {
            tenantId: exactInput.tenantId,
            flagKey: GUEST_GENERAL_WEB_TENANT_FLAG_KEY,
          },
        },
        select: { enabled: true, metadata: true },
      })
    },
  )
})
