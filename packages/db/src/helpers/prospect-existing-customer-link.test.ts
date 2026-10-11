/* eslint-disable @typescript-eslint/no-explicit-any -- deterministic transactional database seam */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../client', () => ({ db: {} }))
vi.mock('./audit', () => ({ writeAuditLogStrict: vi.fn() }))
import { linkProspectConversionAction } from './prospect-actions'

const args = {
  organizationId: 'prospect-a',
  prospectVenueId: 'location-a',
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  existingLink: { expectedVersion: 1 },
  actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'operator-a' } as const,
}
function fixture() {
  let relationship: any = null
  let location: any = null
  const tx: any = {
    prospectOrganization: {
      findUnique: vi.fn(async () => ({
        id: 'prospect-a',
        archivedAt: null,
        opportunity: { id: 'opp-a', stage: 'NEW' },
      })),
    },
    tenant: { findUnique: vi.fn(async () => ({ id: 'tenant-a', name: 'Sample Gardens' })) },
    venue: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.tenantId === 'tenant-a' && where.id === 'venue-a' ? { id: 'venue-a' } : null,
      ),
    },
    prospectVenue: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.organizationId === 'prospect-a' && where.id === 'location-a'
          ? { id: 'location-a' }
          : null,
      ),
    },
    prospectConversion: { findFirst: vi.fn(async () => null) },
    prospectCustomerRelationship: {
      findFirst: vi.fn(async ({ where }: any) => (where.OR ? null : relationship)),
      findMany: vi.fn(async () => []),
      create: vi.fn(
        async ({ data }: any) =>
          (relationship = { ...data, id: 'relationship-a', startedAt: new Date() }),
      ),
    },
    prospectLocationConversion: {
      findFirst: vi.fn(async ({ where }: any) => (where.OR ? null : location)),
      create: vi.fn(
        async ({ data }: any) =>
          (location = { ...data, id: 'conversion-a', convertedAt: new Date() }),
      ),
    },
    prospectActivity: { count: vi.fn(async () => 0), create: vi.fn(async () => ({})) },
    prospectOpportunity: { update: vi.fn() },
    prospectStageHistory: { create: vi.fn() },
  }
  const database: any = { $transaction: vi.fn(async (callback: any) => callback(tx)) }
  return { tx, database }
}
describe('existing customer CRM relationship repair', () => {
  it('creates canonical links once and exact replay adds no activity or stage history', async () => {
    const { tx, database } = fixture()
    const first = await linkProspectConversionAction(args, database)
    tx.prospectActivity.count.mockResolvedValue(99)
    const second = await linkProspectConversionAction(args, database)
    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.relationship.id).toBe(first.relationship.id)
    expect(tx.prospectCustomerRelationship.create).toHaveBeenCalledTimes(1)
    expect(tx.prospectLocationConversion.create).toHaveBeenCalledTimes(1)
    expect(tx.prospectActivity.create).toHaveBeenCalledTimes(1)
    expect(tx.prospectStageHistory.create).not.toHaveBeenCalled()
    expect(tx.prospectOpportunity.update).not.toHaveBeenCalled()
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    })
  })
  it.each([{ tenantId: 'tenant-b' }, { venueId: 'venue-b' }, { prospectVenueId: 'location-b' }])(
    'refuses mismatched identity %j before writing',
    async (patch) => {
      const { tx, database } = fixture()
      await expect(
        linkProspectConversionAction({ ...args, ...patch }, database),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(tx.prospectCustomerRelationship.create).not.toHaveBeenCalled()
    },
  )
  it.each(['prospectCustomerRelationship', 'prospectLocationConversion', 'prospectConversion'])(
    'refuses existing conflicting %s',
    async (model) => {
      const { tx, database } = fixture()
      tx[model].findFirst.mockImplementation(async ({ where }: any) =>
        where.OR ? { id: 'conflict' } : null,
      )
      await expect(linkProspectConversionAction(args, database)).rejects.toMatchObject({
        code: 'CONFLICT',
      })
      expect(tx.prospectCustomerRelationship.create).not.toHaveBeenCalled()
    },
  )
  it('refuses stale review before writing', async () => {
    const { tx, database } = fixture()
    tx.prospectActivity.count.mockResolvedValue(1)
    await expect(linkProspectConversionAction(args, database)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(tx.prospectCustomerRelationship.create).not.toHaveBeenCalled()
  })
  it.each([
    { archivedAt: new Date(), opportunity: { stage: 'NEW' } },
    { archivedAt: null, opportunity: { stage: 'DO_NOT_CONTACT' } },
  ])('preserves archived and do-not-contact state', async (state) => {
    const { tx, database } = fixture()
    tx.prospectOrganization.findUnique.mockResolvedValue(state)
    await expect(linkProspectConversionAction(args, database)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(tx.prospectCustomerRelationship.create).not.toHaveBeenCalled()
  })
})
