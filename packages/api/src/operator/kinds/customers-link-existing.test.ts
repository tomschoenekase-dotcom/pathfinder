/* eslint-disable @typescript-eslint/no-explicit-any -- operator grant and database seams */
import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ link: vi.fn() }))
vi.mock('@pathfinder/db', () => ({ linkProspectConversionAction: mocks.link }))
import { customersLinkExistingKind as kind } from './customers-link-existing'
const args = {
  organizationId: 'prospect-a',
  prospectVenueId: 'location-a',
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  expectedVersion: 1,
  operationId: 'a82b320c-2b00-4fa8-b094-9a8dcda96236',
}
function context(allTenants = true): any {
  return {
    grant: { allTenants, tenantIds: ['tenant-a'] },
    actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'owner-a' },
    operationId: args.operationId,
    proposalId: 'proposal-a',
    database: {
      tenant: { findUnique: vi.fn(async () => ({ id: 'tenant-a' })) },
      venue: { findFirst: vi.fn(async () => ({ id: 'venue-a' })) },
      prospectVenue: { findFirst: vi.fn(async () => ({ id: 'location-a' })) },
      prospectLocationConversion: { findFirst: vi.fn(async () => null) },
      prospectConversion: { findFirst: vi.fn(async () => null) },
      prospectCustomerRelationship: { findFirst: vi.fn(async () => null) },
      prospectOpportunity: { findUnique: vi.fn(async () => ({ id: 'opp-a' })) },
      prospectActivity: { count: vi.fn(async () => 0) },
    },
  }
}
describe('existing customer link operator boundary', () => {
  it('rejects a tenant-limited grant before database access, including apply', async () => {
    const ctx = context(false)
    await expect(kind.authorize!(args, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(kind.apply(args, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(ctx.database.tenant.findUnique).not.toHaveBeenCalled()
  })
  it('checks exact existing customer venue and CRM location ownership', async () => {
    const ctx = context()
    await kind.authorize!(args, ctx)
    expect(ctx.database.venue.findFirst).toHaveBeenCalledWith({
      where: { id: args.venueId, tenantId: args.tenantId },
      select: { id: true },
    })
    expect(ctx.database.prospectVenue.findFirst).toHaveBeenCalledWith({
      where: {
        id: args.prospectVenueId,
        organizationId: args.organizationId,
        organization: { archivedAt: null },
      },
      select: { id: true },
    })
    ctx.database.venue.findFirst.mockResolvedValue(null)
    await expect(kind.apply(args, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('uses the canonical strict action and scoped database, without provisioning', async () => {
    const ctx = context()
    mocks.link.mockResolvedValue({
      relationship: { id: 'relationship-a' },
      locationConversion: { id: 'conversion-a' },
      replayed: false,
    })
    const result = await kind.apply(args, ctx)
    expect(mocks.link).toHaveBeenCalledWith(
      {
        organizationId: args.organizationId,
        prospectVenueId: args.prospectVenueId,
        tenantId: args.tenantId,
        venueId: args.venueId,
        existingLink: { expectedVersion: 1 },
        evidence: { operatorProposalId: 'proposal-a', operationId: args.operationId },
        actor: ctx.actor,
      },
      ctx.database,
    )
    expect(result.result).toMatchObject({
      relationshipId: 'relationship-a',
      locationConversionId: 'conversion-a',
    })
  })
  it('reconciles only an exact active location and relationship pair', async () => {
    const ctx = context()
    expect(await kind.reconcile!(args, ctx)).toEqual({ state: 'not_applied' })
    ctx.database.prospectLocationConversion.findFirst.mockImplementation(async ({ where }: any) =>
      where.OR ? null : { id: 'conversion-a', relationshipId: 'relationship-a' },
    )
    expect(await kind.reconcile!(args, ctx)).toMatchObject({
      state: 'applied',
      outcome: { result: { replayed: true } },
    })
    ctx.database.prospectCustomerRelationship.findFirst.mockResolvedValue({ id: 'conflict' })
    expect(await kind.reconcile!(args, ctx)).toEqual({ state: 'unknown' })
    expect(ctx.database.prospectLocationConversion.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: args.tenantId,
        prospectVenueId: args.prospectVenueId,
        venueId: args.venueId,
        status: 'ACTIVE',
        relationship: {
          organizationId: args.organizationId,
          tenantId: args.tenantId,
          status: 'ACTIVE',
        },
      },
      select: { id: true, relationshipId: true },
    })
  })
})
