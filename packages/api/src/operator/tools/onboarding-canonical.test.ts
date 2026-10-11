/* eslint-disable @typescript-eslint/no-explicit-any -- bounded database doubles */
import { describe, expect, it, vi } from 'vitest'
import { OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'
import { onboardingReadTools } from './onboarding'

const at = new Date('2026-10-10T18:00:00.000Z')
function setup(relationships: unknown[], legacy: unknown = null) {
  const database = {
    tenant: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'tenant-a',
        name: 'Example Garden',
        slug: 'example-garden',
        status: 'ACTIVE',
        planTier: 'FREE',
        createdAt: at,
      }),
    },
    prospectConversion: { findFirst: vi.fn().mockResolvedValue(legacy) },
    prospectCustomerRelationship: { findMany: vi.fn().mockResolvedValue(relationships) },
    tenantMembership: { count: vi.fn().mockResolvedValue(1) },
    venue: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    intakeV1Submission: { count: vi.fn().mockResolvedValue(0) },
    venuePackage: { groupBy: vi.fn().mockResolvedValue([]) },
    agentQuestion: { count: vi.fn().mockResolvedValue(0) },
    onboardingQuestionLink: { count: vi.fn().mockResolvedValue(0) },
    supportRequest: { count: vi.fn().mockResolvedValue(0) },
  }
  const context = { database, grant: { allTenants: false, tenantIds: ['tenant-a'] } } as any
  const read = async (tenantId = 'tenant-a') =>
    OPERATOR_MCP_OUTPUTS['customers.get_onboarding'].parse(
      await onboardingReadTools[0]!.handler({ tenantId }, context),
    )
  return { database, read }
}
const relationship = {
  organizationId: 'prospect-a',
  startedAt: at,
  locationConversions: [{ prospectVenueId: 'location-a', venueId: 'venue-a', convertedAt: at }],
}

describe('onboarding canonical CRM links', () => {
  it('shows the canonical location and scopes all relationship queries to the authorized tenant', async () => {
    const { database, read } = setup([relationship])
    expect((await read()).prospectConversion).toEqual({
      organizationId: 'prospect-a',
      prospectVenueId: 'location-a',
      venueId: 'venue-a',
      convertedAt: at.toISOString(),
    })
    expect(database.prospectCustomerRelationship.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-a', status: 'ACTIVE' },
        select: expect.objectContaining({
          locationConversions: expect.objectContaining({
            where: { tenantId: 'tenant-a', status: 'ACTIVE', venue: { tenantId: 'tenant-a' } },
          }),
        }),
      }),
    )
  })
  it('retains the legacy fallback only without canonical relationships', async () => {
    const old = {
      organizationId: 'old-prospect',
      prospectVenueId: null,
      venueId: null,
      convertedAt: at,
    }
    expect((await setup([], old).read()).prospectConversion?.organizationId).toBe('old-prospect')
    expect((await setup([relationship], old).read()).prospectConversion?.organizationId).toBe(
      'prospect-a',
    )
  })
  it('does not select an arbitrary active CRM account or location', async () => {
    const result = await setup([
      relationship,
      { ...relationship, organizationId: 'prospect-b' },
    ]).read()
    expect(result.prospectConversion).toBeNull()
    expect(result.gaps).toContain('Multiple active CRM account links require review.')
    const multiple = await setup([
      {
        ...relationship,
        locationConversions: [
          ...relationship.locationConversions,
          { ...relationship.locationConversions[0], venueId: 'venue-b' },
        ],
      },
    ]).read()
    expect(multiple.prospectConversion).toMatchObject({
      organizationId: 'prospect-a',
      venueId: null,
      prospectVenueId: null,
    })
  })
  it('refuses an out-of-grant tenant before database access', async () => {
    const { database, read } = setup([relationship])
    await expect(read('tenant-b')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(database.tenant.findUnique).not.toHaveBeenCalled()
    expect(database.prospectCustomerRelationship.findMany).not.toHaveBeenCalled()
  })
})
