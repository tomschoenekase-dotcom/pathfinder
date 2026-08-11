import { describe, expect, it, vi } from 'vitest'

import type { PrevalidatedPartnerCredential } from '@pathfinder/contracts/partner-read-api'

import {
  createPartnerReadRegistry,
  type PartnerReadDomainActions,
  type PartnerReadSecurityHooks,
} from './registry'

const credential: PrevalidatedPartnerCredential = {
  credentialId: 'key-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  venueIds: ['venue-1'],
  capabilities: [
    'clients:read',
    'venues:read',
    'approved-content:read',
    'configuration:read',
    'readiness:read',
    'updates:read',
  ],
}
const context = { credential, requestId: 'request-1' } as const
const success = { data: { id: 'result-1' }, nextCursor: null } as const

function actions(): PartnerReadDomainActions {
  return {
    getClient: vi.fn().mockResolvedValue(success),
    listVenues: vi.fn().mockResolvedValue(success),
    listApprovedContent: vi.fn().mockResolvedValue(success),
    getPartnerSafeConfiguration: vi.fn().mockResolvedValue(success),
    getReadiness: vi.fn().mockResolvedValue(success),
    listPartnerVisibleUpdates: vi.fn().mockResolvedValue(success),
  }
}

function hooks(): PartnerReadSecurityHooks {
  return {
    checkCredentialActive: vi.fn().mockResolvedValue({ active: true }),
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    writeAuditEvent: vi.fn().mockResolvedValue(undefined),
  }
}

describe('dark partner read registry', () => {
  it('is unavailable unless the existing exact feature flag is enabled', () => {
    expect(createPartnerReadRegistry(actions(), hooks(), {})).toBeNull()
    expect(
      createPartnerReadRegistry(actions(), hooks(), { PARTNER_READ_API_ENABLED: 'TRUE' }),
    ).toBeNull()
    expect(
      createPartnerReadRegistry(actions(), hooks(), { PARTNER_READ_API_ENABLED: 'true' }),
    ).not.toBeNull()
  })

  it('requires current credential, rate-limit, scope, and audit boundaries around a read', async () => {
    const domain = actions()
    const security = hooks()
    const registry = createPartnerReadRegistry(domain, security, {
      PARTNER_READ_API_ENABLED: 'true',
    })!
    const result = await registry.call(
      'approved-content.list',
      { clientId: 'client-1', venueId: 'venue-1', limit: 25 },
      context,
    )
    expect(result).toEqual(success)
    expect(security.checkCredentialActive).toHaveBeenCalledWith(context)
    expect(security.checkRateLimit).toHaveBeenCalledWith(context, 'approved-content.list')
    expect(domain.listApprovedContent).toHaveBeenCalledOnce()
    expect(security.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: 'key-1',
        tenantId: 'tenant-1',
        clientId: 'client-1',
        venueId: 'venue-1',
        operation: 'approved-content.list',
        outcome: 'allowed',
      }),
    )
  })

  it('blocks cross-client, cross-venue, injected-tenant, and missing-capability requests', async () => {
    for (const [input, scopedCredential] of [
      [{ clientId: 'client-2', venueId: 'venue-1', limit: 25 }, credential],
      [{ clientId: 'client-1', venueId: 'venue-2', limit: 25 }, credential],
      [{ tenantId: 'tenant-2', clientId: 'client-1', venueId: 'venue-1', limit: 25 }, credential],
      [
        { clientId: 'client-1', venueId: 'venue-1', limit: 25 },
        { ...credential, capabilities: ['clients:read'] },
      ],
    ] as const) {
      const domain = actions()
      const security = hooks()
      const registry = createPartnerReadRegistry(domain, security, {
        PARTNER_READ_API_ENABLED: 'true',
      })!
      await expect(
        registry.call('approved-content.list', input, {
          credential: scopedCredential as PrevalidatedPartnerCredential,
          requestId: 'request-denied',
        }),
      ).rejects.toMatchObject({
        code: input && 'tenantId' in input ? 'INVALID_REQUEST' : 'FORBIDDEN',
      })
      expect(domain.listApprovedContent).not.toHaveBeenCalled()
      expect(security.writeAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: input && 'tenantId' in input ? 'failed' : 'denied',
        }),
      )
    }
  })

  it('fails closed for revoked credentials, rate limits, and audit failure', async () => {
    const revokedHooks = hooks()
    vi.mocked(revokedHooks.checkCredentialActive).mockResolvedValue({ active: false })
    const revoked = createPartnerReadRegistry(actions(), revokedHooks, {
      PARTNER_READ_API_ENABLED: 'true',
    })!
    await expect(
      revoked.call('clients.get', { clientId: 'client-1' }, context),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_INACTIVE' })

    const limitedHooks = hooks()
    vi.mocked(limitedHooks.checkRateLimit).mockResolvedValue({ allowed: false })
    const limited = createPartnerReadRegistry(actions(), limitedHooks, {
      PARTNER_READ_API_ENABLED: 'true',
    })!
    await expect(
      limited.call('clients.get', { clientId: 'client-1' }, context),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })

    const brokenAudit = hooks()
    vi.mocked(brokenAudit.writeAuditEvent).mockRejectedValue(
      new Error('audit backend secret detail'),
    )
    const unauditable = createPartnerReadRegistry(actions(), brokenAudit, {
      PARTNER_READ_API_ENABLED: 'true',
    })!
    await expect(
      unauditable.call('clients.get', { clientId: 'client-1' }, context),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed.',
    })
  })

  it('redacts domain failures and rejects malformed output', async () => {
    const failedDomain = actions()
    vi.mocked(failedDomain.getClient).mockRejectedValue(new Error('database hostname and secret'))
    const registry = createPartnerReadRegistry(failedDomain, hooks(), {
      PARTNER_READ_API_ENABLED: 'true',
    })!
    await expect(
      registry.call('clients.get', { clientId: 'client-1' }, context),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed.',
    })

    const malformedDomain = actions()
    vi.mocked(malformedDomain.getClient).mockResolvedValue({ data: undefined } as never)
    const malformed = createPartnerReadRegistry(malformedDomain, hooks(), {
      PARTNER_READ_API_ENABLED: 'true',
    })!
    await expect(
      malformed.call('clients.get', { clientId: 'client-1' }, context),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })
})
