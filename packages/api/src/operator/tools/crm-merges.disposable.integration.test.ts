import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  createProspectAction,
  db,
  mergeProspectOrganizationsAction,
  previewProspectOrganizationMergeAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { resolveOperatorConfig } from '../config'
import { createOperatorRegistry, defaultVenueRead } from '../registry'

const enabled =
  process.env.RUN_OPERATOR_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('CRM merge canonical readback', () => {
  afterAll(async () => db.$disconnect())

  it('redirects an archived source ID and reveals retained immutable activity lineage', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `merge-owner-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const source = await createProspectAction({
        organization: { canonicalName: `Example North ${suffix}` },
        actor,
      })
      const target = await createProspectAction({
        organization: { canonicalName: `Example Parent ${suffix}` },
        actor,
      })
      await db.prospectActivity.create({
        data: {
          organizationId: source.organization.id,
          type: 'NOTE_ADDED',
          summary: 'Historical source note',
          actorId: actor.id,
        },
      })
      const plan = await previewProspectOrganizationMergeAction({
        sourceOrganizationId: source.organization.id,
        targetOrganizationId: target.organization.id,
      })
      expect(plan.blockers).toEqual([])
      await mergeProspectOrganizationsAction({
        sourceOrganizationId: source.organization.id,
        targetOrganizationId: target.organization.id,
        expectedPlanHash: plan.planHash,
        note: 'Reviewed same account',
        actor,
      })

      const resolved = resolveOperatorConfig({
        OPERATOR_OAUTH_ENABLED: true,
        OPERATOR_OAUTH_ISSUER: 'https://app.operator.test',
        OPERATOR_OAUTH_PEPPERS: 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        OPERATOR_OAUTH_REDIRECT_ORIGINS: 'https://connector.example.com',
        OPERATOR_OAUTH_ALLOWED_USER_IDS: actor.id,
        RAILWAY_ENVIRONMENT: 'staging',
      })
      if (resolved.status !== 'ready') throw new Error('operator config not ready')
      const output = await createOperatorRegistry().callTool(
        'crm.get_account_context',
        { organizationId: source.organization.id },
        {
          config: resolved.config,
          database: db,
          grant: {
            grantId: `grant-${suffix}`,
            clientId: 'client-example',
            userId: actor.id,
            allTenants: true,
            tenantIds: [],
            capabilities: ['crm:read'],
          },
          now: new Date(),
          requestId: randomUUID(),
          venueRead: defaultVenueRead(db),
        },
      )
      const account = OPERATOR_MCP_OUTPUTS['crm.get_account_context'].parse(output)
      expect(account.organization.organizationId).toBe(target.organization.id)
      expect(account.mergeLineage).toMatchObject({
        redirectedFromOrganizationId: source.organization.id,
        sources: [
          {
            sourceOrganizationId: source.organization.id,
            retainedActivities: expect.any(Number),
            retainedEvidence: expect.any(Number),
          },
        ],
        truncated: false,
      })
      expect(account.mergeLineage.sources[0]!.retainedActivities).toBeGreaterThanOrEqual(1)
    })
  })
})
