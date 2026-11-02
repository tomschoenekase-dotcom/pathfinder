/* eslint-disable @typescript-eslint/no-explicit-any -- scoped transaction fake */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./audit', () => ({ writeAuditLogStrict: vi.fn(async () => undefined) }))

import { writeAuditLogStrict } from './audit'
import { applyVenueDistributionChangeAction, VenueDistributionActionError } from './venue-distribution-actions'

type Origin = { id: string; tenantId: string; venueId: string; origin: string; state: 'ACTIVE' | 'REVOKED' }

function fakeClient(options: { revision?: number | null; origins?: Origin[]; venue?: boolean } = {}) {
  let distribution = options.revision === null || options.revision === undefined
    ? null
    : { websiteState: 'DISABLED', appState: 'DISABLED', revision: options.revision }
  const origins = [...(options.origins ?? [])]
  const tx = {
    venue: { findFirst: vi.fn(async ({ where }: any) => (options.venue === false || where.tenantId !== 't1' ? null : { id: where.id })) },
    venueDistribution: {
      findFirst: vi.fn(async () => distribution),
      upsert: vi.fn(async ({ create, update }: any) => {
        distribution = distribution
          ? { ...distribution, ...Object.fromEntries(Object.entries(update).filter(([key]) => key.endsWith('State'))), revision: distribution.revision + 1 }
          : { websiteState: 'DISABLED', appState: 'DISABLED', ...Object.fromEntries(Object.entries(create).filter(([key]) => key.endsWith('State'))), revision: 0 }
        return distribution
      }),
    },
    venueWebsiteOrigin: {
      findFirst: vi.fn(async ({ where }: any) => origins.find((row) => row.origin === where.origin && row.state === where.state && row.tenantId === where.tenantId) ?? null),
      count: vi.fn(async () => origins.filter((row) => row.state === 'ACTIVE').length),
      create: vi.fn(async ({ data }: any) => { const row = { id: `o${origins.length + 1}`, state: 'ACTIVE' as const, ...data }; origins.push(row); return { id: row.id } }),
      updateMany: vi.fn(async ({ where }: any) => { const row = origins.find((item) => item.id === where.id && item.state === 'ACTIVE'); if (row) row.state = 'REVOKED'; return { count: row ? 1 : 0 } }),
    },
  }
  // Like a database transaction, a failed run leaves no partial writes behind.
  const transaction = async (run: any) => {
    const savedDistribution = distribution && { ...distribution }
    const savedOrigins = origins.map((row) => ({ ...row }))
    try {
      return await run(tx)
    } catch (error) {
      distribution = savedDistribution
      origins.splice(0, origins.length, ...savedOrigins)
      throw error
    }
  }
  return { client: { $transaction: transaction } as any, tx, origins }
}

const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }
const base = { tenantId: 't1', venueId: 'v1', reason: 'Venue asked for embedding', actor }

describe('applyVenueDistributionChangeAction', () => {
  it('enables a surface at the exact revision and writes a strict audit row', async () => {
    const { client } = fakeClient({ revision: 3 })
    const result = await applyVenueDistributionChangeAction({ ...base, expectedRevision: 3, change: { kind: 'SET_SURFACE', surface: 'WEBSITE', enabled: true } }, client)
    expect(result).toMatchObject({ revision: 4, websiteState: 'ENABLED' })
    expect(writeAuditLogStrict).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.venue-distribution.website.enabled', actorRole: 'PLATFORM_ADMIN', tenantId: 't1' }), expect.anything())
  })

  it('refuses a change reviewed against an older revision', async () => {
    const { client, tx } = fakeClient({ revision: 5 })
    await expect(applyVenueDistributionChangeAction({ ...base, expectedRevision: 4, change: { kind: 'SET_SURFACE', surface: 'APP', enabled: true } }, client))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.venueDistribution.upsert).not.toHaveBeenCalled()
  })

  it('accepts only exact normalized HTTPS origins', async () => {
    for (const origin of ['http://example.org', 'https://example.org/path', 'https://*.example.org', 'HTTPS://Example.org']) {
      const { client } = fakeClient({ revision: 0 })
      await expect(applyVenueDistributionChangeAction({ ...base, expectedRevision: 0, change: { kind: 'ADD_ORIGIN', origin } }, client))
        .rejects.toBeInstanceOf(VenueDistributionActionError)
    }
  })

  it('adds and revokes an origin, keeping the 20-origin cap and duplicate check', async () => {
    const { client, origins } = fakeClient({ revision: 0 })
    await applyVenueDistributionChangeAction({ ...base, expectedRevision: 0, change: { kind: 'ADD_ORIGIN', origin: 'https://www.example.org' } }, client)
    expect(origins).toHaveLength(1)
    await expect(applyVenueDistributionChangeAction({ ...base, expectedRevision: 1, change: { kind: 'ADD_ORIGIN', origin: 'https://www.example.org' } }, client))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await applyVenueDistributionChangeAction({ ...base, expectedRevision: 1, change: { kind: 'REVOKE_ORIGIN', origin: 'https://www.example.org' } }, client)
    expect(origins[0]!.state).toBe('REVOKED')
    const full = fakeClient({ revision: 0, origins: Array.from({ length: 20 }, (_, index) => ({ id: `x${index}`, tenantId: 't1', venueId: 'v1', origin: `https://site${index}.example.org`, state: 'ACTIVE' as const })) })
    await expect(applyVenueDistributionChangeAction({ ...base, expectedRevision: 0, change: { kind: 'ADD_ORIGIN', origin: 'https://new.example.org' } }, full.client))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('never acts for another tenant or without a platform administrator', async () => {
    const { client } = fakeClient({ revision: 0 })
    await expect(applyVenueDistributionChangeAction({ ...base, tenantId: 't2', expectedRevision: 0, change: { kind: 'SET_SURFACE', surface: 'WEBSITE', enabled: true } }, client))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(applyVenueDistributionChangeAction({ ...base, actor: { ...actor, role: 'MANAGER' as never }, expectedRevision: 0, change: { kind: 'SET_SURFACE', surface: 'WEBSITE', enabled: true } }, client))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
