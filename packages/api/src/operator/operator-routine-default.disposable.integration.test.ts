import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { setAutonomyPolicy } from './autonomy'
import { resolveOperatorConfig } from './config'
import { OperatorNotFoundError } from './grants'
import { OPERATOR_PROPOSAL_KINDS } from './kinds'
import type { VerifiedOperatorGrant } from './oauth'
import { createKindRegistry, createProposal } from './proposals'

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
const tenantId = `routine-${suffix}`
const foreignTenantId = `routine-foreign-${suffix}`
const clientId = `routine-client-${suffix}`
const kinds = createKindRegistry(OPERATOR_PROPOSAL_KINDS)
let grant: VerifiedOperatorGrant
let previousPolicy: Awaited<ReturnType<typeof db.operatorAutonomyPolicy.findUnique>>

function propose(targetTenantId: string, slug: string) {
  return createProposal(
    'venues.propose_create',
    { tenantId: targetTenantId, name: 'Example Draft', slug, operationId: randomUUID() },
    {
      config,
      database: db,
      grant,
      kinds,
      now: new Date(),
      requestId: randomUUID(),
    },
  )
}

describe.skipIf(!enabled)(
  'routine operator defaults on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      previousPolicy = await db.operatorAutonomyPolicy.findUnique({
        where: { capability: 'venues:propose' },
      })
      await db.operatorAutonomyPolicy.deleteMany({ where: { capability: 'venues:propose' } })
      await withTenantIsolationBypass(async () => {
        for (const id of [tenantId, foreignTenantId]) {
          await db.tenant.create({ data: { id, name: `Example ${id}`, slug: id } })
        }
      })
      await db.operatorOAuthClient.create({
        data: {
          id: clientId,
          clientName: 'Example connector',
          redirectUris: ['https://connector.example.com/cb'],
          registrationIpHash: 'a'.repeat(64),
          consentedAt: new Date(),
        },
      })
      const row = await db.operatorGrant.create({
        data: {
          clientId,
          userId: 'user_owner',
          allTenants: false,
          tenantIds: [tenantId],
          capabilities: [...OperatorCapability.options],
          resource: config.resource,
          scope: 'operator',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })
      grant = {
        grantId: row.id,
        clientId,
        userId: 'user_owner',
        allTenants: false,
        tenantIds: [tenantId],
        capabilities: [...OperatorCapability.options],
      }
    })

    afterAll(async () => {
      if (previousPolicy) {
        await db.operatorAutonomyPolicy.upsert({
          where: { capability: 'venues:propose' },
          create: previousPolicy,
          update: {
            mode: previousPolicy.mode,
            allowedKinds: previousPolicy.allowedKinds,
            updatedByUserId: previousPolicy.updatedByUserId,
          },
        })
      } else {
        await db.operatorAutonomyPolicy.deleteMany({ where: { capability: 'venues:propose' } })
      }
      await db.$disconnect()
    })

    it('applies a private draft without a policy row, but never crosses the tenant grant', async () => {
      const slug = `routine-auto-${suffix}`
      const applied = await propose(tenantId, slug)
      expect(applied.status).toBe('APPLIED')
      expect(
        await db.operatorProposal.findUniqueOrThrow({ where: { id: applied.proposalId } }),
      ).toMatchObject({ autoApproved: true })
      expect(await db.venue.count({ where: { tenantId, slug, isActive: false } })).toBe(1)
      await expect(propose(foreignTenantId, `foreign-${suffix}`)).rejects.toBeInstanceOf(
        OperatorNotFoundError,
      )
      expect(await db.venue.count({ where: { tenantId: foreignTenantId } })).toBe(0)
    })

    it('honors an owner ASK row over the routine default', async () => {
      await setAutonomyPolicy({
        capability: 'venues:propose',
        mode: 'ask',
        userId: 'user_owner',
        requestId: randomUUID(),
      })
      const slug = `routine-ask-${suffix}`
      expect(await propose(tenantId, slug)).toMatchObject({ status: 'PENDING' })
      expect(await db.venue.count({ where: { tenantId, slug } })).toBe(0)
    })
  },
)
