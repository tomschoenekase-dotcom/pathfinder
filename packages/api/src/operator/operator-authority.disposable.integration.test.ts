/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed parsed output */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import {
  OperatorAutonomyLockedError,
  readAutonomyPolicies,
  readPolicyRevision,
  setAutonomyPolicies,
} from './autonomy'
import { admit, OPERATOR_AUTO_APPLIES_PER_HOUR } from './admission'
import { resolveOperatorConfig } from './config'
import { OPERATOR_PROPOSAL_KINDS } from './kinds'
import { createPlan } from './plans'
import type { VerifiedOperatorGrant } from './oauth'
import { approveAndApplyProposal, createKindRegistry, createProposal } from './proposals'

/**
 * Owner policy, preview binding and dispatch-time authority on a real disposable PostgreSQL.
 * Invented names and example domains only. Runs only against a database named pathfinder_disposable_*.
 */
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
const kinds = createKindRegistry(OPERATOR_PROPOSAL_KINDS)
const dependencies = { database: db, kinds, allowedUserIds: config.allowedUserIds }

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const tenantId = `auth-tenant-${suffix}`
const clientId = `opc_auth_${suffix}`
const otherClientId = `opc_auth_other_${suffix}`

let grant: VerifiedOperatorGrant
let otherGrant: VerifiedOperatorGrant
const ASK_FIXTURE_CAPABILITIES = ['appearance:propose', 'crm:propose', 'venues:propose'] as const
let originalPolicies: Awaited<ReturnType<typeof db.operatorAutonomyPolicy.findMany>> | null = null

async function makeGrant(forClient: string): Promise<VerifiedOperatorGrant> {
  const row = await db.operatorGrant.create({
    data: {
      clientId: forClient,
      userId: 'user_owner',
      allTenants: false,
      tenantIds: [tenantId],
      capabilities: [...OperatorCapability.options],
      resource: config.resource,
      scope: 'operator',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  return {
    grantId: row.id,
    clientId: forClient,
    userId: 'user_owner',
    allTenants: false,
    tenantIds: [tenantId],
    capabilities: [...OperatorCapability.options],
  }
}

const service = (forGrant = grant) => ({
  config,
  database: db,
  grant: forGrant,
  kinds,
  now: new Date(),
  requestId: randomUUID(),
})

const propose = (tool: string, args: Record<string, unknown>, forGrant = grant) =>
  createProposal(tool, { ...args, operationId: randomUUID() }, service(forGrant))

const approve = (view: { proposalId: string; argsHash: string }) =>
  approveAndApplyProposal(
    {
      proposalId: view.proposalId,
      argsHash: view.argsHash,
      actorUserId: 'user_owner',
      requestId: randomUUID(),
      now: new Date(),
    },
    dependencies,
  )

const change = (changes: Parameters<typeof setAutonomyPolicies>[0]['changes']) =>
  setAutonomyPolicies({ changes, userId: 'user_owner', requestId: randomUUID() })

describe.skipIf(!enabled)(
  'operator authority on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      await withTenantIsolationBypass(async () => {
        await db.tenant.create({
          data: { id: tenantId, name: `Example ${tenantId}`, slug: tenantId },
        })
      })
      for (const id of [clientId, otherClientId]) {
        await db.operatorOAuthClient.create({
          data: {
            id,
            clientName: 'Example connector',
            redirectUris: ['https://connector.example.com/cb'],
            registrationIpHash: 'a'.repeat(64),
            consentedAt: new Date(),
          },
        })
      }
      grant = await makeGrant(clientId)
      otherGrant = await makeGrant(otherClientId)
      // These cases exercise pending approval, revision and revocation. Their prior implicit ASK
      // assumption no longer holds for routine kinds, so establish it as a scoped fixture.
      originalPolicies = await db.operatorAutonomyPolicy.findMany({
        where: { capability: { in: [...ASK_FIXTURE_CAPABILITIES] } },
      })
      await change(ASK_FIXTURE_CAPABILITIES.map((capability) => ({ capability, mode: 'ask' })))
    })

    afterAll(async () => {
      // Restore each prior policy's settings, including a missing-row default.
      for (const capability of originalPolicies ? ASK_FIXTURE_CAPABILITIES : []) {
        const original = originalPolicies?.find((row) => row.capability === capability)
        if (original) {
          await db.operatorAutonomyPolicy.upsert({
            where: { capability },
            create: {
              capability,
              mode: original.mode,
              allowedKinds: original.allowedKinds,
              updatedByUserId: original.updatedByUserId,
            },
            update: {
              mode: original.mode,
              allowedKinds: original.allowedKinds,
              updatedByUserId: original.updatedByUserId,
            },
          })
        } else {
          await db.operatorAutonomyPolicy.deleteMany({ where: { capability } })
        }
      }
      await withTenantIsolationBypass(() =>
        db.embeddingDispatch.deleteMany({ where: { tenantId } }),
      )
      await db.$disconnect()
    })

    it('applies a batch atomically with one revision bump, and a bad item changes nothing', async () => {
      const before = await readPolicyRevision(db)
      const { revision } = await change([
        { capability: 'venues:propose', mode: 'auto' },
        { capability: 'crm:propose', mode: 'auto', kinds: ['crm.stage-change'] },
      ])
      expect(revision).toBe(before + 1)
      const policies = Object.fromEntries(
        (await readAutonomyPolicies(db)).map((policy) => [policy.capability, policy]),
      )
      expect(policies['venues:propose']).toMatchObject({ mode: 'auto' })
      expect(policies['venues:propose']!.autoKinds).toEqual(
        expect.arrayContaining(['venues.create', 'venues.publish', 'venues.knowledge']),
      )
      // A switch that names kinds covers exactly those.
      expect(policies['crm:propose']).toMatchObject({
        mode: 'auto',
        autoKinds: ['crm.stage-change'],
      })

      // One invalid entry (a locked capability) rejects the whole batch: nothing is written.
      await expect(
        change([
          { capability: 'appearance:propose', mode: 'auto' },
          { capability: 'customers:propose', mode: 'auto' },
        ]),
      ).rejects.toBeInstanceOf(OperatorAutonomyLockedError)
      // Naming a kind the server does not implement is also refused whole.
      await expect(
        change([{ capability: 'appearance:propose', mode: 'auto', kinds: ['appearance.future'] }]),
      ).rejects.toBeInstanceOf(OperatorAutonomyLockedError)
      expect(await readPolicyRevision(db)).toBe(revision)
      const after = Object.fromEntries(
        (await readAutonomyPolicies(db)).map((policy) => [policy.capability, policy]),
      )
      expect(after['appearance:propose']).toMatchObject({ mode: 'ask' })
      await change([
        { capability: 'venues:propose', mode: 'ask' },
        { capability: 'crm:propose', mode: 'ask' },
      ])
    })

    it('an AUTO switch that names kinds leaves every other kind asking, end to end', async () => {
      await change([{ capability: 'crm:propose', mode: 'auto', kinds: ['crm.stage-change'] }])
      const org = await db.prospectOrganization.create({
        data: {
          canonicalName: `Example Org ${suffix}`,
          normalizedName: `example org ${suffix}`,
          createdBy: 'seed',
          updatedBy: 'seed',
          opportunity: { create: { stage: 'RESEARCHED', createdBy: 'seed', updatedBy: 'seed' } },
        },
      })
      const staged = await propose('crm.propose_stage_change', {
        organizationId: org.id,
        expectedVersion: 1,
        stage: 'QUALIFIED',
      })
      expect(staged.status).toBe('APPLIED')
      const row = await db.operatorProposal.findUniqueOrThrow({ where: { id: staged.proposalId } })
      // The policy revision it was decided under is recorded with it.
      expect(row.policyRevision).toBe(await readPolicyRevision(db))
      expect(row.autoApproved).toBe(true)
      await change([{ capability: 'crm:propose', mode: 'ask' }])
    })

    it('refuses to apply an approval whose preview no longer matches, and changes nothing', async () => {
      const slug = `digest-${suffix}`
      const view = await propose('venues.propose_create', {
        tenantId,
        name: 'Example Digest',
        slug,
      })
      // Simulate a release that changed what this kind would show for the same stored arguments.
      await db.operatorProposal.update({
        where: { id: view.proposalId },
        data: { previewDigest: 'f'.repeat(64) },
      })
      const applied = await approve(view)
      expect(applied).toMatchObject({ status: 'STALE', failureCode: 'PREVIEW_CHANGED' })
      expect(await db.venue.count({ where: { tenantId, slug } })).toBe(0)
      // A fresh proposal for the same change carries the current digest and applies normally.
      const fresh = await propose('venues.propose_create', {
        tenantId,
        name: 'Example Digest',
        slug,
      })
      expect((await approve(fresh)).status).toBe('APPLIED')
    })

    it('revoking the connection (client) blocks work that was already queued', async () => {
      const slug = `client-revoked-${suffix}`
      const view = await propose(
        'venues.propose_create',
        { tenantId, name: 'Example Client', slug },
        otherGrant,
      )
      await db.operatorOAuthClient.update({
        where: { id: otherClientId },
        data: { revokedAt: new Date() },
      })
      const applied = await approve(view)
      expect(applied).toMatchObject({ status: 'FAILED', failureCode: 'GRANT_REVOKED' })
      expect(await db.venue.count({ where: { tenantId, slug } })).toBe(0)
    })

    it('admits a concurrent burst exactly up to the limit and records one denial per window', async () => {
      const key = `test:${suffix}`
      const now = new Date('2026-09-30T12:00:20.000Z')
      const results = await Promise.all(
        Array.from({ length: 40 }, () => admit(db, key, 10, 60_000, now)),
      )
      expect(results.filter((result) => result.allowed)).toHaveLength(10)
      // Exactly one request sees itself as the first denial, however many were turned away.
      expect(results.filter((result) => result.firstDenial)).toHaveLength(1)
      expect(Math.max(...results.map((result) => result.count))).toBe(40)
      // Retries after denial do not move the window: it still ends at the same instant.
      expect(results.every((result) => result.retryAfterSeconds === 40)).toBe(true)
      // The next window starts clean.
      const later = await admit(db, key, 10, 60_000, new Date('2026-09-30T12:01:05.000Z'))
      expect(later).toMatchObject({ allowed: true, count: 1 })
    })

    it('routine venue creation does not become a human approval when the hourly budget is spent', async () => {
      await change([{ capability: 'venues:propose', mode: 'auto' }])
      const slug = `budget-${suffix}`
      try {
        const spent = new Date()
        const windowStart = new Date(Math.floor(spent.getTime() / 3_600_000) * 3_600_000)
        await db.operatorAdmissionCounter.upsert({
          where: { key_windowStart: { key: `auto:${grant.grantId}`, windowStart } },
          create: {
            key: `auto:${grant.grantId}`,
            windowStart,
            count: OPERATOR_AUTO_APPLIES_PER_HOUR,
          },
          update: { count: OPERATOR_AUTO_APPLIES_PER_HOUR },
        })
        const view = await propose('venues.propose_create', {
          tenantId,
          name: 'Example Budget',
          slug,
        })
        // Routine work uses the per-minute transport throttle, without an approval-volume quota.
        expect(view.status).toBe('APPLIED')
        expect(await db.venue.count({ where: { tenantId, slug } })).toBe(1)
        expect((await approve(view)).status).toBe('APPLIED')
        expect(await db.venue.count({ where: { tenantId, slug } })).toBe(1)
        const plan = await createPlan(
          {
            operationId: randomUUID(),
            title: 'Create two private example guides',
            steps: [1, 2].map((index) => ({
              tool: 'venues.propose_create',
              arguments: {
                tenantId,
                name: `Example Guide ${index}`,
                slug: `${slug}-plan-${index}`,
              },
            })),
          },
          service(),
        )
        expect(plan.status).toBe('APPLIED')
        expect(
          await db.venue.count({
            where: { tenantId, slug: { in: [`${slug}-plan-1`, `${slug}-plan-2`] } },
          }),
        ).toBe(2)
      } finally {
        await change([{ capability: 'venues:propose', mode: 'ask' }])
      }
    })

    it('reports who initiated and who authorized, separately', async () => {
      await change([{ capability: 'venues:propose', mode: 'ask' }])
      const view = await propose('venues.propose_create', {
        tenantId,
        name: 'Example Lineage',
        slug: `lineage-${suffix}`,
      })
      const row = await db.operatorProposal.findUniqueOrThrow({ where: { id: view.proposalId } })
      expect(row.clientId).toBe(clientId)
      expect(row.decidedByUserId).toBeNull()
      expect((await approve(view)).status).toBe('APPLIED')
      const decided = await db.operatorProposal.findUniqueOrThrow({
        where: { id: view.proposalId },
      })
      expect(decided).toMatchObject({ decidedByUserId: 'user_owner', autoApproved: false })
    })
  },
)
