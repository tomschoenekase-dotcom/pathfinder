/* eslint-disable @typescript-eslint/no-explicit-any -- independent adversarial database boundary */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client', () => ({ db: {} }))
const audit = vi.hoisted(() => vi.fn())
vi.mock('./audit', () => ({ writeAuditLogStrict: audit }))
import { linkProspectConversionAction } from './prospect-actions'

const input = {
  organizationId: 'prospect-alpha',
  prospectVenueId: 'site-alpha',
  tenantId: 'tenant-alpha',
  venueId: 'venue-alpha',
  existingLink: { expectedVersion: 1 },
  actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'operator-alpha' } as const,
}
type Legacy = { organizationId: string; prospectVenueId: string; tenantId: string; venueId: string }
function matches(row: Legacy, where: Record<string, any>): boolean {
  return Object.entries(where).every(([field, expected]) =>
    typeof expected === 'object'
      ? row[field as keyof Legacy] !== expected.not
      : row[field as keyof Legacy] === expected,
  )
}
function fixture(legacy: Legacy | null = null) {
  let relationship: any = null
  let location: any = null
  const tx: any = {
    prospectOrganization: {
      findUnique: vi.fn(async () => ({
        id: input.organizationId,
        archivedAt: null,
        opportunity: null,
      })),
    },
    tenant: { findUnique: vi.fn(async () => ({ id: input.tenantId, name: 'Fictional Garden' })) },
    venue: { findFirst: vi.fn(async () => ({ id: input.venueId })) },
    prospectVenue: { findFirst: vi.fn(async () => ({ id: input.prospectVenueId })) },
    prospectConversion: {
      findFirst: vi.fn(async ({ where }: any) =>
        legacy && where.OR.some((branch: any) => matches(legacy, branch))
          ? { id: 'legacy-link' }
          : null,
      ),
    },
    prospectCustomerRelationship: {
      findFirst: vi.fn(async ({ where }: any) => (where.OR ? null : relationship)),
      findMany: vi.fn(async () => []),
      create: vi.fn(
        async ({ data }: any) =>
          (relationship = { ...data, id: 'relationship-alpha', startedAt: new Date('2026-01-01') }),
      ),
    },
    prospectLocationConversion: {
      findFirst: vi.fn(async ({ where }: any) => (where.OR ? null : location)),
      create: vi.fn(
        async ({ data }: any) =>
          (location = { ...data, id: 'location-alpha', convertedAt: new Date('2026-01-01') }),
      ),
    },
    prospectActivity: { count: vi.fn(async () => 0), create: vi.fn(async () => ({})) },
    prospectOpportunity: { update: vi.fn() },
    prospectStageHistory: { create: vi.fn() },
  }
  const database: any = { $transaction: vi.fn(async (callback: any) => callback(tx)) }
  return { database, tx }
}

beforeEach(() => audit.mockReset())
describe('independent existing-link security review', () => {
  it.each([
    { tenantId: 'tenant-beta', venueId: 'venue-beta' },
    { organizationId: 'prospect-beta', prospectVenueId: 'site-beta' },
    { venueId: 'venue-beta' },
    { prospectVenueId: 'site-beta' },
  ])('refuses incompatible legacy ownership %j without writes', async (patch) => {
    const { database, tx } = fixture({ ...input, ...patch })
    await expect(linkProspectConversionAction(input, database)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(tx.prospectCustomerRelationship.create).not.toHaveBeenCalled()
    expect(tx.prospectLocationConversion.create).not.toHaveBeenCalled()
    expect(tx.prospectActivity.create).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('upgrades the exact legacy pair once and preserves audit idempotence', async () => {
    const { database, tx } = fixture(input)
    const first = await linkProspectConversionAction(input, database)
    const second = await linkProspectConversionAction(input, database)
    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.relationship.id).toBe(first.relationship.id)
    expect(second.locationConversion?.id).toBe(first.locationConversion?.id)
    expect(tx.prospectActivity.create).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledTimes(1)
    expect(tx.prospectConversion.findFirst).toHaveBeenCalledTimes(2)
  })

  it('rejects a non-platform actor before opening a transaction', async () => {
    const { database } = fixture()
    await expect(
      linkProspectConversionAction(
        { ...input, actor: { ...input.actor, role: 'OWNER' } as any },
        database,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(database.$transaction).not.toHaveBeenCalled()
  })

  it('does not report success when the required audit fails', async () => {
    const { database } = fixture()
    audit.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(linkProspectConversionAction(input, database)).rejects.toThrow('audit unavailable')
    // This seam verifies failure propagation; only a real database can prove transaction rollback.
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    })
  })
})
