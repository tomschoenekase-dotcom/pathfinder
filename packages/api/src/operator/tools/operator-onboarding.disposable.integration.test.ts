/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed parsed output */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OPERATOR_MCP_OUTPUTS, OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { createVenueAction, db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveOperatorConfig } from '../config'
import { OperatorNotFoundError } from '../grants'
import type { VerifiedOperatorGrant } from '../oauth'
import { createOperatorRegistry, defaultVenueRead } from '../registry'

/** Onboarding dossier on a real disposable PostgreSQL. Invented names only. */
const enabled =
  process.env.RUN_OPERATOR_DB_INTEGRATION === '1' &&
  /^postgres(?:ql)?:\/\/[^/]+\/pathfinder_disposable_[a-z0-9_]+(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

const resolution = resolveOperatorConfig({
  OPERATOR_OAUTH_ENABLED: true,
  OPERATOR_OAUTH_ISSUER: 'https://app.operator.test',
  OPERATOR_OAUTH_PEPPERS: `k1:${randomBytes(32).toString('base64url')}`,
  OPERATOR_OAUTH_REDIRECT_ORIGINS: 'https://connector.example.com',
  OPERATOR_OAUTH_ALLOWED_USER_IDS: 'user_owner',
  RAILWAY_ENVIRONMENT: 'staging',
})
if (resolution.status !== 'ready') throw new Error('operator config not ready')
const config = resolution.config

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const tenantA = `ob-a-${suffix}`
const tenantB = `ob-b-${suffix}`
const clientId = `ob-client-${suffix}`

function grant(tenantIds: string[]): VerifiedOperatorGrant {
  return {
    grantId: `ob-grant-${suffix}`,
    clientId,
    userId: 'user_owner',
    allTenants: false,
    tenantIds,
    capabilities: [...OperatorCapability.options],
  }
}

const registry = createOperatorRegistry()
async function dossier(tenantId: string, tenantIds = [tenantA]) {
  const output = await registry.callTool(
    'customers.get_onboarding',
    { tenantId },
    {
      config,
      database: db,
      grant: grant(tenantIds),
      now: new Date(),
      requestId: randomUUID(),
      venueRead: defaultVenueRead(db),
    },
  )
  return OPERATOR_MCP_OUTPUTS['customers.get_onboarding'].parse(output) as any
}

describe.skipIf(!enabled)(
  'customers.get_onboarding on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    let venueId = ''

    beforeAll(async () => {
      await withTenantIsolationBypass(async () => {
        await db.tenant.create({
          data: { id: tenantA, name: `Example Alpha ${suffix}`, slug: tenantA },
        })
        await db.tenant.create({
          data: { id: tenantB, name: `Example Beta ${suffix}`, slug: tenantB },
        })
        venueId = (
          await createVenueAction({
            tenantId: tenantA,
            actor: { type: 'HUMAN', id: 'user_owner', role: 'OWNER' },
            name: 'Example Garden',
            baseSlug: `ob-garden-${suffix}`,
            callerSuppliedSlug: true,
            guideMode: 'non_location',
            initiallyActive: false,
            operationKey: randomUUID(),
          })
        ).record.id
      })
    })

    afterAll(async () => {
      await withTenantIsolationBypass(() =>
        db.embeddingDispatch.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } }),
      )
      await db.$disconnect()
    })

    it('reports a brand-new account with its draft venue and the gaps that follow', async () => {
      const result = await dossier(tenantA)
      expect(result.tenantId).toBe(tenantA)
      expect(result.prospectConversion).toBeNull()
      expect(result.members).toEqual({ active: 0, other: 0 })
      expect(result.venues).toHaveLength(1)
      expect(result.venues[0]).toMatchObject({ venueId, live: false, knowledgeEntries: 0 })
      expect(result.venuesComplete).toBe(true)
      expect(result.packages).toEqual({ draft: 0, reviewed: 0, applied: 0, reverted: 0 })
      expect(result.gaps).toEqual(
        expect.arrayContaining([
          'No active member can sign in yet.',
          'No venue is live; every venue is still a draft.',
          'This account is not linked to a CRM account.',
        ]),
      )
    })

    it('reflects support waiting on the customer from canonical rows', async () => {
      await withTenantIsolationBypass(() =>
        db.supportRequest.create({
          data: {
            tenantId: tenantA,
            venueId,
            category: 'CONTENT_CORRECTION',
            status: 'WAITING_FOR_CLIENT',
            subject: 'Example question',
            createdByKind: 'OPERATOR',
            createdById: clientId,
            updatedByKind: 'OPERATOR',
            updatedById: clientId,
          },
        }),
      )
      const result = await dossier(tenantA)
      expect(result.support).toEqual({ open: 0, waitingForCustomer: 1 })
      expect(result.gaps).toContain('1 support request(s) wait on the customer.')
    })

    it('never reveals a tenant outside the grant', async () => {
      await expect(dossier(tenantB)).rejects.toBeInstanceOf(OperatorNotFoundError)
      await expect(dossier(`missing-${suffix}`, [`missing-${suffix}`])).rejects.toBeInstanceOf(
        OperatorNotFoundError,
      )
    })
  },
)
