import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import { db } from '@pathfinder/db'

import { createSafeOperationalMcpRegistry } from './composition'

const enabled =
  process.env.RUN_AI_COST_OBSERVABILITY_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('AI cost observability MCP disposable integration', () => {
  afterAll(async () => db.$disconnect())

  it('returns exact venue usage and tenant hard-budget state without private policy material or authority', async () => {
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `cost-observability-${suffix}`
    const venueId = `cost-observability-venue-${suffix}`
    const otherVenueId = `cost-observability-other-${suffix}`
    const privateMarker = `private-cost-policy-${suffix}`
    const now = new Date()

    await db.tenant.create({ data: { id: tenantId, name: 'Cost proof', slug: tenantId } })
    await db.venue.createMany({
      data: [
        { id: venueId, tenantId, name: 'Cost proof venue', slug: venueId },
        { id: otherVenueId, tenantId, name: 'Other proof venue', slug: otherVenueId },
      ],
    })
    await db.aiUsageDailyRollup.createMany({
      data: [
        {
          tenantId,
          venueId,
          date: new Date('2026-08-23T00:00:00.000Z'),
          feature: 'guest-chat',
          requestCount: 3,
          successfulRequestCount: 2,
          failedRequestCount: 1,
          totalTokens: 150,
          estimatedCostUsd: '0.12500000',
        },
        {
          tenantId,
          venueId: otherVenueId,
          date: new Date('2026-08-23T00:00:00.000Z'),
          feature: 'private-other-venue-feature',
          requestCount: 99,
          totalTokens: 999,
          estimatedCostUsd: '9.99000000',
        },
      ],
    })
    await db.aiCostBudget.create({
      data: {
        tenantId,
        coverageVersion: 'gateway-v1',
        enabled: true,
        startsAt: new Date(now.getTime() - 60_000),
        endsAt: new Date(now.getTime() + 60 * 60_000),
        limitUnits: 2_000_000_000n,
        remainingUnits: 700_000_000n,
        reservedUnits: 300_000_000n,
        committedUnits: 1_000_000_000n,
        epoch: 2,
        revision: 4,
        breachedAt: now,
        updatedBy: privateMarker,
        reason: privateMarker,
      },
    })

    const credential: VerifiedMcpCredentialScope = {
      credentialId: `credential-${suffix}`,
      tenantId,
      clientId: tenantId,
      venueIds: [venueId],
      capabilities: ['resources:read', 'ai-usage:read'],
    }
    const registry = createSafeOperationalMcpRegistry(db)
    const result = await registry.callTool(
      'pathfinder.read',
      { resource: 'ai-usage', clientId: tenantId, venueId, limit: 25 },
      { credential },
    )

    expect(result.structuredContent).toMatchObject({
      kind: 'pathfinder.ai-usage',
      data: {
        schemaVersion: 'pathfinder.ai-usage.v2',
        scope: { clientId: tenantId, venueId },
        costProtection: {
          configured: true,
          coverageVersion: 'gateway-v1',
          state: 'BREACHED',
          hardLimitUsd: '20.00000000',
          remainingUsd: '7.00000000',
          reservedUsd: '3.00000000',
          committedUsd: '10.00000000',
          epoch: 2,
          revision: 4,
        },
        boundaries: {
          anomalyThresholdPolicy: 'UNRESOLVED',
          automaticBudgetMutationAuthorized: false,
          automaticServiceSuspensionAuthorized: false,
          customerPricingImpact: 'NONE',
          operatorReasonIncluded: false,
          operatorIdentityIncluded: false,
        },
        items: [
          {
            feature: 'guest-chat',
            requestCount: 3,
            failedRequestCount: 1,
            totalTokens: 150,
            estimatedCostUsd: '0.12500000',
          },
        ],
        nextCursor: null,
      },
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(privateMarker)
    expect(serialized).not.toContain('private-other-venue-feature')
    expect(serialized).not.toContain(otherVenueId)

    await expect(
      registry.callTool(
        'pathfinder.read',
        { resource: 'ai-usage', clientId: tenantId, venueId: otherVenueId, limit: 25 },
        { credential },
      ),
    ).rejects.toThrow('Venue scope denied')
  })
})
