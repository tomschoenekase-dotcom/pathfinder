/* eslint-disable @typescript-eslint/no-explicit-any -- test helper reads loosely typed JSON results */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/rate-limit', () => ({ checkRateLimit: vi.fn().mockResolvedValue(true) }))

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import {
  createOffboardingDraftAction,
  db,
  reviewOffboardingPlanForExportAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { resolveOperatorConfig } from '../config'
import { OperatorCapabilityError, OperatorNotFoundError } from '../grants'
import type { VerifiedOperatorGrant } from '../oauth'
import {
  approveAndApplyProposal,
  createKindRegistry,
  createProposal,
  createRevertProposal,
} from '../proposals'
import { venueRouter } from '../../routers/venue'
import { OPERATOR_PROPOSAL_KINDS } from './index'
import { offboardingExecutionKind, setOffboardingHooksForTests } from './offboarding-execution'

/**
 * Offboarding execution on a real disposable PostgreSQL. Run serially. Nothing here reaches a
 * payment provider or an identity provider; neither has a seam in the code under test. Invented
 * names only.
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
  OPERATOR_OAUTH_ALLOWED_USER_IDS: 'user_offboard_admin',
  RAILWAY_ENVIRONMENT: 'staging',
})
if (resolution.status !== 'ready') throw new Error('operator config not ready')
const config = resolution.config
const kinds = createKindRegistry(OPERATOR_PROPOSAL_KINDS)
const dependencies = { database: db, kinds, allowedUserIds: config.allowedUserIds }

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const adminId = 'user_offboard_admin'
const clientId = `opc_offboard_${suffix}`
const allCapabilities = [...OperatorCapability.options]
let allGrant: VerifiedOperatorGrant
let narrowGrant: VerifiedOperatorGrant
let noCapabilityGrant: VerifiedOperatorGrant
let strangerGrant: VerifiedOperatorGrant

const embeddingTenants: string[] = []

const makeGrant = async (
  all: boolean,
  tenants: string[],
  capabilities: string[],
  userId = adminId,
) => {
  const row = await db.operatorGrant.create({
    data: {
      clientId,
      userId,
      allTenants: all,
      tenantIds: tenants,
      capabilities,
      resource: config.resource,
      scope: 'operator',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  return {
    grantId: row.id,
    clientId,
    userId,
    allTenants: all,
    tenantIds: tenants,
    capabilities: capabilities as OperatorCapability[],
  } satisfies VerifiedOperatorGrant
}

const service = (forGrant: VerifiedOperatorGrant) => ({
  config,
  database: db,
  grant: forGrant,
  kinds,
  now: new Date(),
  requestId: randomUUID(),
})
const propose = (args: Record<string, unknown>, forGrant = allGrant, operationId = randomUUID()) =>
  createProposal('offboarding.propose_execution', { ...args, operationId }, service(forGrant))
const approve = (view: { proposalId: string; argsHash: string }) =>
  approveAndApplyProposal(
    {
      proposalId: view.proposalId,
      argsHash: view.argsHash,
      actorUserId: adminId,
      requestId: randomUUID(),
      now: new Date(),
    },
    dependencies,
  )

type Customer = {
  tenantId: string
  venueIds: string[]
  planId: string
  userIds: string[]
  routineId: string
  credentialId: string
  singleGrantId: string
  sharedGrantId: string
  otherTenantId: string
}

const ALL_TARGETS = [
  'GUEST_LINKS',
  'WIDGETS',
  'PARTNER_API_KEYS',
  'MCP_CREDENTIALS',
  'BACKGROUND_JOBS',
  'AGENT_IDENTITIES',
  'CLIENT_ACCESS',
  'OPERATOR_IMPERSONATION',
] as const

const planActor = { type: 'HUMAN', id: adminId, role: 'PLATFORM_ADMIN' } as const

/** A customer with everything an offboarding has to switch off, and a reviewed plan for it. */
async function makeCustomer(
  label: string,
  options: {
    review?: boolean
    planVenueCount?: number
    targets?: readonly (typeof ALL_TARGETS)[number][]
  } = {},
): Promise<Customer> {
  const tag = `${label}${suffix}`
  const tenantId = `ob-tenant-${tag}`
  const otherTenantId = `ob-other-${tag}`
  embeddingTenants.push(tenantId, otherTenantId)
  return withTenantIsolationBypass(async () => {
    await db.tenant.create({ data: { id: tenantId, name: `Example ${label}`, slug: tenantId } })
    await db.tenant.create({
      data: { id: otherTenantId, name: `Example other ${label}`, slug: otherTenantId },
    })
    const venueIds = [`ob-venue-a-${tag}`, `ob-venue-b-${tag}`]
    for (const [index, id] of venueIds.entries()) {
      await db.venue.create({
        data: { id, tenantId, name: `Example Garden ${index}`, slug: id, isActive: true },
      })
    }
    await db.place.create({
      data: { tenantId, venueId: venueIds[0]!, name: 'Example Fountain', type: 'ATTRACTION' },
    })
    const userIds = [`ob-user-1-${tag}`, `ob-user-2-${tag}`]
    for (const id of userIds) {
      await db.user.create({ data: { id, email: `${id}@example.test` } })
    }
    await db.tenantMembership.create({
      data: {
        tenantId,
        userId: userIds[0]!,
        role: 'OWNER',
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
    })
    await db.tenantMembership.create({
      data: { tenantId, userId: userIds[1]!, role: 'STAFF', status: 'INVITED' },
    })
    const identity = await db.agentIdentity.create({
      data: {
        tenantId,
        venueId: venueIds[0]!,
        identityKey: `offboard.${tag}`,
        name: 'Example worker',
        agentType: 'CONTENT',
        accessScope: 'VENUE',
        accessCapabilities: ['content.draft'],
        autonomyLevel: 'DRAFT',
        enabled: true,
        createdBy: adminId,
      },
    })
    const routine = await db.agentRoutine.create({
      data: {
        tenantId,
        venueId: venueIds[0]!,
        routineKey: `daily.${tag}`,
        agentIdentityId: identity.id,
        requestedOperation: 'content.review',
        prompt: 'Example routine prompt.',
        intervalSeconds: 3600,
        enabled: true,
        nextRunAt: new Date(Date.now() + 60_000),
        createdBy: adminId,
      },
    })
    await db.venueReportConfiguration.create({
      data: { tenantId, venueId: venueIds[0]!, enabled: true, updatedBy: adminId },
    })
    await db.liveDataConnector.create({
      data: {
        tenantId,
        venueId: venueIds[0]!,
        name: 'Example feed',
        kind: 'GENERIC_JSON',
        provider: 'example',
        resourceId: `feed-${tag}`,
        resourceLabel: 'Example feed',
        endpointUrl: 'https://feed.example.com/status.json',
        endpointHost: 'feed.example.com',
        mapping: {},
        pollIntervalSeconds: 300,
        freshnessBudgetSeconds: 900,
        timezone: 'UTC',
        state: 'ACTIVE',
        nextPollAt: new Date(Date.now() + 60_000),
        createdBy: adminId,
        updatedBy: adminId,
      },
    })
    const scope = { tenantId, clientId: tenantId, scopeKey: venueIds[0]! }
    const credential = await db.$transaction(async (tx) => {
      const row = await tx.externalAccessCredential.create({
        data: {
          ...scope,
          venueId: venueIds[0]!,
          kind: 'MCP',
          label: 'Example credential',
          capabilities: ['resources:read'],
          secretPrefix: `fx-${tag}`,
          secretHash: '$argon2id$not-a-real-credential',
          // A new credential is always issued disabled; revocation does not need it enabled.
          enabled: false,
          createdBy: adminId,
        },
      })
      await tx.externalCredentialOperationReceipt.create({
        data: {
          operationId: randomUUID(),
          operationHash: 'a'.repeat(64),
          operationKind: 'ISSUE',
          ...scope,
          venueId: venueIds[0]!,
          credentialId: row.id,
          actorId: adminId,
          createdAt: row.createdAt,
        },
      })
      return row
    })
    await db.agentBridgeSession.create({
      data: {
        ...scope,
        venueId: venueIds[0]!,
        credentialId: credential.id,
        provider: 'CODEX_SUBSCRIPTION',
        label: 'Example bridge',
        runnerVersion: 'fixture',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    const single = await makeGrant(false, [tenantId], allCapabilities)
    const shared = await makeGrant(false, [tenantId, otherTenantId], allCapabilities)

    const draft = await createOffboardingDraftAction({
      tenantId,
      requestId: randomUUID(),
      venueIds: venueIds.slice(0, options.planVenueCount ?? 2),
      revocationTargets: [...(options.targets ?? ALL_TARGETS)],
      exportKinds: ['APPROVED_CONTENT'],
      actor: planActor,
    })
    if (options.review !== false) {
      await reviewOffboardingPlanForExportAction({
        tenantId,
        planId: draft.id,
        operationId: randomUUID(),
        expectedUpdatedAt: draft.updatedAt,
        actor: planActor,
      })
    }
    return {
      tenantId,
      venueIds,
      planId: draft.id,
      userIds,
      routineId: routine.id,
      credentialId: credential.id,
      singleGrantId: single.grantId,
      sharedGrantId: shared.grantId,
      otherTenantId,
    }
  })
}

const stepStatuses = async (planId: string, tenantId: string) =>
  Object.fromEntries(
    (
      await db.offboardingExecutionStep.findMany({
        where: { tenantId, execution: { planId } },
        select: { key: true, status: true },
      })
    ).map((step) => [step.key, step.status]),
  )

const dataCounts = (customer: Customer) =>
  withTenantIsolationBypass(async () => ({
    tenants: await db.tenant.count({ where: { id: customer.tenantId } }),
    venues: await db.venue.count({ where: { tenantId: customer.tenantId } }),
    places: await db.place.count({ where: { tenantId: customer.tenantId } }),
    memberships: await db.tenantMembership.count({ where: { tenantId: customer.tenantId } }),
    routines: await db.agentRoutine.count({ where: { tenantId: customer.tenantId } }),
    credentials: await db.externalAccessCredential.count({
      where: { tenantId: customer.tenantId },
    }),
    connectors: await db.liveDataConnector.count({ where: { tenantId: customer.tenantId } }),
    identities: await db.agentIdentity.count({ where: { tenantId: customer.tenantId } }),
    plans: await db.offboardingPlan.count({ where: { tenantId: customer.tenantId } }),
  }))

const guestLookup = (venueId: string) =>
  venueRouter
    .createCaller({
      db,
      headers: new Headers(),
      session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
    })
    .getBySlug({ slug: venueId })

describe.skipIf(!enabled)(
  'operator offboarding execution on disposable PostgreSQL',
  { timeout: 180_000 },
  () => {
    beforeAll(async () => {
      await db.user.upsert({
        where: { id: adminId },
        create: { id: adminId, email: `admin-${suffix}@example.test` },
        update: {},
      })
      await db.operatorOAuthClient.create({
        data: {
          id: clientId,
          clientName: 'Example connector',
          redirectUris: ['https://connector.example.com/cb'],
          registrationIpHash: 'b'.repeat(64),
          consentedAt: new Date(),
        },
      })
      allGrant = await makeGrant(true, [], allCapabilities)
      narrowGrant = await makeGrant(false, [`nobody-${suffix}`], allCapabilities)
      noCapabilityGrant = await makeGrant(
        true,
        [],
        allCapabilities.filter((capability) => capability !== 'customers:propose'),
      )
      // The grant's owner is not on the approver allowlist, so nothing it proposes can apply.
      strangerGrant = await makeGrant(true, [], allCapabilities, 'user_not_allowed')
    })

    beforeEach(() => {
      process.env.OPERATOR_OFFBOARDING_EXECUTION_ENABLED = 'true'
    })

    afterEach(() => {
      delete process.env.OPERATOR_OFFBOARDING_EXECUTION_ENABLED
      setOffboardingHooksForTests(null)
    })

    afterAll(async () => {
      await withTenantIsolationBypass(() =>
        db.embeddingDispatch.deleteMany({ where: { tenantId: { in: embeddingTenants } } }),
      )
      await db.$disconnect()
    })

    it('is dark unless the deployment turns it on', async () => {
      const customer = await makeCustomer('off')
      delete process.env.OPERATOR_OFFBOARDING_EXECUTION_ENABLED
      await expect(
        propose({ tenantId: customer.tenantId, planId: customer.planId }),
      ).rejects.toMatchObject({ code: 'DISABLED' })
      expect(await db.offboardingExecution.count({ where: { tenantId: customer.tenantId } })).toBe(
        0,
      )
    })

    it('always asks, even under a named AUTO policy, and nothing applies until a person approves', async () => {
      const customer = await makeCustomer('ask')
      await db.operatorAutonomyPolicy.upsert({
        where: { capability: 'customers:propose' },
        create: {
          capability: 'customers:propose',
          mode: 'AUTO',
          allowedKinds: ['offboarding.execution'],
          updatedByUserId: 'test',
        },
        update: { mode: 'AUTO', allowedKinds: ['offboarding.execution'] },
      })
      try {
        const view = await propose({ tenantId: customer.tenantId, planId: customer.planId })
        expect(view.status).toBe('PENDING')
        expect(
          await db.offboardingExecution.count({ where: { tenantId: customer.tenantId } }),
        ).toBe(0)
        expect(
          await db.venue.count({ where: { tenantId: customer.tenantId, isActive: true } }),
        ).toBe(2)
      } finally {
        await db.operatorAutonomyPolicy.deleteMany({ where: { capability: 'customers:propose' } })
      }
    })

    it('refuses a connection that does not reach the customer, and a plan of another customer', async () => {
      const customer = await makeCustomer('wrongtenant')
      const other = await makeCustomer('wrongother')
      await expect(
        propose({ tenantId: customer.tenantId, planId: customer.planId }, narrowGrant),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      // The plan exists, but not under this customer: it looks exactly like a missing one.
      await expect(
        propose({ tenantId: customer.tenantId, planId: other.planId }),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      await expect(
        propose({ tenantId: customer.tenantId, planId: 'plan_does_not_exist' }),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      expect(
        await db.offboardingExecution.count({
          where: { tenantId: { in: [customer.tenantId, other.tenantId] } },
        }),
      ).toBe(0)
    })

    it('refuses a connection without the capability, and a connection whose owner may not approve', async () => {
      const customer = await makeCustomer('role')
      await expect(
        propose({ tenantId: customer.tenantId, planId: customer.planId }, noCapabilityGrant),
      ).rejects.toBeInstanceOf(OperatorCapabilityError)
      const view = await propose(
        { tenantId: customer.tenantId, planId: customer.planId },
        strangerGrant,
      )
      const applied = await approve(view)
      expect(applied.status).toBe('FAILED')
      expect(applied.failureCode).toBe('GRANT_REVOKED')
      expect(await db.venue.count({ where: { tenantId: customer.tenantId, isActive: true } })).toBe(
        2,
      )
      expect(await db.offboardingExecution.count({ where: { tenantId: customer.tenantId } })).toBe(
        0,
      )
    })

    it('refuses a plan nobody reviewed, a plan that leaves a venue out, and a live paid arrangement', async () => {
      const unreviewed = await makeCustomer('unreviewed', { review: false })
      await expect(
        propose({ tenantId: unreviewed.tenantId, planId: unreviewed.planId }),
      ).rejects.toMatchObject({ code: 'PLAN_NOT_APPROVED' })

      const partial = await makeCustomer('partial', { planVenueCount: 1 })
      await expect(
        propose({ tenantId: partial.tenantId, planId: partial.planId }),
      ).rejects.toMatchObject({ code: 'PLAN_SCOPE_INCOMPLETE' })

      const paying = await makeCustomer('paying')
      await db.billingAccount.create({
        data: {
          tenantId: paying.tenantId,
          displayNameSnapshot: 'Example paying customer',
          billingMode: 'MANUAL_INVOICE',
          status: 'ACTIVE',
          createdBy: adminId,
          updatedBy: adminId,
        },
      })
      await expect(
        propose({ tenantId: paying.tenantId, planId: paying.planId }),
      ).rejects.toMatchObject({ code: 'BILLING_ACTIVE' })
      // Saying it is handled needs a note.
      await expect(
        propose({ tenantId: paying.tenantId, planId: paying.planId, billingHandled: true }),
      ).rejects.toThrow()
      const handled = await propose({
        tenantId: paying.tenantId,
        planId: paying.planId,
        billingHandled: true,
        billingNote: 'Subscription cancelled by hand and final invoice settled.',
      })
      expect(handled.status).toBe('PENDING')
      for (const customer of [unreviewed, partial, paying]) {
        expect(
          await db.venue.count({ where: { tenantId: customer.tenantId, isActive: true } }),
        ).toBe(2)
      }
    })

    it('offboards the whole customer, records every step, and keeps all data', async () => {
      const customer = await makeCustomer('happy')
      const control = await makeCustomer('control')
      const before = await dataCounts(customer)
      const controlBefore = await dataCounts(control)
      // Both venues serve guests now.
      for (const venueId of customer.venueIds) {
        await expect(guestLookup(venueId)).resolves.toMatchObject({ name: expect.any(String) })
      }

      const view = await propose({ tenantId: customer.tenantId, planId: customer.planId })
      expect(view.status).toBe('PENDING')
      const applied = await approve(view)
      expect(applied.status, JSON.stringify([applied.failureCode, applied.result])).toBe('APPLIED')
      const result = applied.result as any
      expect(result).toMatchObject({
        status: 'COMPLETED',
        replayed: false,
        dataDeleted: false,
        planId: customer.planId,
      })
      expect(result.steps.map((step: any) => step.step)).toEqual([
        'PUBLIC_ACCESS',
        'SCHEDULED_WORK',
        'CONNECTIONS',
        'MEMBER_ACCESS',
        'BILLING',
        'IDENTITY_PROVIDER',
        'DATA_MANIFEST',
      ])
      // No payment or identity provider was reached: both are checklist items for a person.
      expect(await stepStatuses(customer.planId, customer.tenantId)).toEqual({
        PUBLIC_ACCESS: 'COMPLETE',
        SCHEDULED_WORK: 'COMPLETE',
        CONNECTIONS: 'COMPLETE',
        MEMBER_ACCESS: 'COMPLETE',
        BILLING: 'COMPLETE', // no billing account exists, so there is nothing to cancel
        IDENTITY_PROVIDER: 'ACTION_REQUIRED',
        DATA_MANIFEST: 'COMPLETE',
      })
      expect(result.humanActions.join(' ')).toMatch(/identity provider/iu)
      expect(result.futureDecisions.join(' ')).toMatch(/retention and deletion/iu)
      expect(result.manifest).toMatchObject({ venues: 2, places: 1, memberships: 2, routines: 1 })
      expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/u)

      await withTenantIsolationBypass(async () => {
        // Public access: closed, and guest chat / QR / embeds show the neutral unavailable state.
        expect(
          await db.venue.count({ where: { tenantId: customer.tenantId, isActive: true } }),
        ).toBe(0)
        // Scheduled work stopped.
        const routine = await db.agentRoutine.findFirstOrThrow({
          where: { id: customer.routineId, tenantId: customer.tenantId },
        })
        expect(routine).toMatchObject({ enabled: false, nextRunAt: null })
        expect(
          await db.venueReportConfiguration.count({
            where: { tenantId: customer.tenantId, enabled: true },
          }),
        ).toBe(0)
        expect(
          await db.liveDataConnector.count({
            where: { tenantId: customer.tenantId, state: 'ACTIVE' },
          }),
        ).toBe(0)
        // Connections ended.
        const credential = await db.externalAccessCredential.findFirstOrThrow({
          where: { id: customer.credentialId, tenantId: customer.tenantId },
        })
        expect(credential.revokedAt).not.toBeNull()
        expect(
          await db.externalCredentialRevocation.count({
            where: { tenantId: customer.tenantId, reasonCode: 'TENANT_OFFBOARDING' },
          }),
        ).toBe(1)
        expect(
          await db.agentBridgeSession.count({
            where: { tenantId: customer.tenantId, status: { not: 'REVOKED' } },
          }),
        ).toBe(0)
        expect(
          await db.agentIdentity.count({ where: { tenantId: customer.tenantId, enabled: true } }),
        ).toBe(0)
        // A connection limited to this customer is gone; one that reaches several only loses it.
        expect(
          (await db.operatorGrant.findUniqueOrThrow({ where: { id: customer.singleGrantId } }))
            .revokedAt,
        ).not.toBeNull()
        const shared = await db.operatorGrant.findUniqueOrThrow({
          where: { id: customer.sharedGrantId },
        })
        expect(shared.revokedAt).toBeNull()
        expect(shared.tenantIds).toEqual([customer.otherTenantId])
        // The connection that did the work reaches every customer and is untouched.
        expect(
          (await db.operatorGrant.findUniqueOrThrow({ where: { id: allGrant.grantId } })).revokedAt,
        ).toBeNull()
        // Member access suspended.
        expect(
          (await db.tenant.findUniqueOrThrow({ where: { id: customer.tenantId } })).status,
        ).toBe('SUSPENDED')
        expect(
          await db.tenantMembership.count({
            where: { tenantId: customer.tenantId, status: { in: ['ACTIVE', 'INVITED'] } },
          }),
        ).toBe(0)
        // Revocation evidence the plan model already holds: one row per venue per planned target.
        expect(
          await db.offboardingRevocationEvidence.count({
            where: { tenantId: customer.tenantId, planId: customer.planId, outcome: 'COMPLETE' },
          }),
        ).toBe(2 * 7)
        // The plan itself keeps its reviewed status: separate execution evidence, not a rewrite.
        expect(
          (await db.offboardingPlan.findUniqueOrThrow({ where: { id: customer.planId } })).status,
        ).toBe('REVIEWED')
        // Audit coverage.
        const actions = (
          await db.auditLog.findMany({
            where: {
              tenantId: customer.tenantId,
              action: { startsWith: 'offboarding-execution.' },
            },
            select: { action: true },
          })
        ).map((row) => row.action)
        expect(actions).toEqual(
          expect.arrayContaining([
            'offboarding-execution.started',
            'offboarding-execution.step-settled',
            'offboarding-execution.effect',
            'offboarding-execution.completed',
          ]),
        )
      })

      // Guest access is blocked afterwards, for every venue.
      for (const venueId of customer.venueIds) {
        await expect(guestLookup(venueId)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      }

      // Nothing was deleted: every row that existed still exists.
      expect(await dataCounts(customer)).toEqual(before)
      // Another customer is untouched.
      expect(await dataCounts(control)).toEqual(controlBefore)
      expect(await db.venue.count({ where: { tenantId: control.tenantId, isActive: true } })).toBe(
        2,
      )
      expect(
        (await db.tenant.findUniqueOrThrow({ where: { id: control.tenantId } })).status,
      ).not.toBe('SUSPENDED')
    })

    it('records a payment cancellation checklist item and calls no provider when a person handled it', async () => {
      const customer = await makeCustomer('billing')
      await db.billingAccount.create({
        data: {
          tenantId: customer.tenantId,
          displayNameSnapshot: 'Example billed customer',
          billingMode: 'MANUAL_INVOICE',
          status: 'CANCELED',
          createdBy: adminId,
          updatedBy: adminId,
        },
      })
      const applied = await approve(
        await propose({ tenantId: customer.tenantId, planId: customer.planId }),
      )
      expect(applied.status).toBe('APPLIED')
      const steps = await stepStatuses(customer.planId, customer.tenantId)
      expect(steps.BILLING).toBe('ACTION_REQUIRED')
      const billing = await db.offboardingExecutionStep.findFirstOrThrow({
        where: { tenantId: customer.tenantId, key: 'BILLING' },
        select: { outcome: true },
      })
      expect(JSON.stringify(billing.outcome)).toMatch(/cancel or settle/iu)
      expect((applied.result as any).humanActions.join(' ')).toMatch(/payment provider/iu)
    })

    it('is idempotent: a repeat changes nothing and writes no second evidence', async () => {
      const customer = await makeCustomer('repeat')
      const first = await approve(
        await propose({ tenantId: customer.tenantId, planId: customer.planId }),
      )
      expect(first.status).toBe('APPLIED')
      const snapshot = async () =>
        withTenantIsolationBypass(async () => ({
          evidence: await db.offboardingRevocationEvidence.count({
            where: { tenantId: customer.tenantId },
          }),
          audits: await db.auditLog.count({
            where: {
              tenantId: customer.tenantId,
              action: { startsWith: 'offboarding-execution.' },
            },
          }),
          attempts: (
            await db.offboardingExecutionStep.findMany({
              where: { tenantId: customer.tenantId },
              select: { key: true, attempts: true },
              orderBy: { key: 'asc' },
            })
          ).map((step) => `${step.key}:${step.attempts}`),
          revocations: await db.externalCredentialRevocation.count({
            where: { tenantId: customer.tenantId },
          }),
        }))
      const settled = await snapshot()
      const second = await approve(
        await propose({ tenantId: customer.tenantId, planId: customer.planId }),
      )
      expect(second.status).toBe('APPLIED')
      expect((second.result as any).replayed).toBe(true)
      expect(await snapshot()).toEqual(settled)
      expect(await db.offboardingExecution.count({ where: { tenantId: customer.tenantId } })).toBe(
        1,
      )
    })

    it('resumes after a partial failure at the step that failed, and repeats nothing', async () => {
      const customer = await makeCustomer('resume')
      setOffboardingHooksForTests({
        beforeStep: (key) => {
          if (key === 'CONNECTIONS')
            throw Object.assign(new Error('simulated'), { code: 'SIMULATED' })
        },
      })
      const failed = await approve(
        await propose({ tenantId: customer.tenantId, planId: customer.planId }),
      )
      expect(failed.status).toBe('FAILED')
      expect(failed.failureCode).toBe('PARTIALLY_APPLIED')
      expect(JSON.stringify(failed.result)).toMatch(/Failed step: CONNECTIONS/u)
      expect(await stepStatuses(customer.planId, customer.tenantId)).toEqual({
        PUBLIC_ACCESS: 'COMPLETE',
        SCHEDULED_WORK: 'COMPLETE',
        CONNECTIONS: 'FAILED',
        MEMBER_ACCESS: 'PENDING',
        BILLING: 'PENDING',
        IDENTITY_PROVIDER: 'PENDING',
        DATA_MANIFEST: 'PENDING',
      })
      const failedStep = await db.offboardingExecutionStep.findFirstOrThrow({
        where: { tenantId: customer.tenantId, key: 'CONNECTIONS' },
        select: { errorCode: true },
      })
      expect(failedStep.errorCode).toBe('SIMULATED')
      // What already happened stays: the venues are closed and the routine is off; the rest is not.
      expect(await db.venue.count({ where: { tenantId: customer.tenantId, isActive: true } })).toBe(
        0,
      )
      expect(
        (
          await db.externalAccessCredential.findFirstOrThrow({
            where: { id: customer.credentialId, tenantId: customer.tenantId },
          })
        ).revokedAt,
      ).toBeNull()
      expect(
        (await db.tenant.findUniqueOrThrow({ where: { id: customer.tenantId } })).status,
      ).not.toBe('SUSPENDED')
      const evidenceAfterFailure = await db.offboardingRevocationEvidence.count({
        where: { tenantId: customer.tenantId },
      })
      expect(evidenceAfterFailure).toBe(2 * 3) // public access (2 targets) and scheduled work (1)
      const executionAfterFailure = await db.offboardingExecution.findFirstOrThrow({
        where: { tenantId: customer.tenantId },
        select: { id: true, status: true },
      })
      expect(executionAfterFailure.status).toBe('IN_PROGRESS')

      // The same plan, proposed again, picks up at CONNECTIONS.
      setOffboardingHooksForTests(null)
      const resumed = await approve(
        await propose({ tenantId: customer.tenantId, planId: customer.planId }),
      )
      expect(resumed.status).toBe('APPLIED')
      expect(await stepStatuses(customer.planId, customer.tenantId)).toMatchObject({
        PUBLIC_ACCESS: 'COMPLETE',
        SCHEDULED_WORK: 'COMPLETE',
        CONNECTIONS: 'COMPLETE',
        MEMBER_ACCESS: 'COMPLETE',
        DATA_MANIFEST: 'COMPLETE',
      })
      const steps = await db.offboardingExecutionStep.findMany({
        where: { tenantId: customer.tenantId },
        select: { key: true, attempts: true },
      })
      const attempts = Object.fromEntries(steps.map((step) => [step.key, step.attempts]))
      // Steps that settled the first time were not run again; the failed one took a second attempt.
      expect(attempts).toMatchObject({ PUBLIC_ACCESS: 1, SCHEDULED_WORK: 1, CONNECTIONS: 2 })
      expect(await db.offboardingExecution.count({ where: { tenantId: customer.tenantId } })).toBe(
        1,
      )
      expect(
        (await db.offboardingExecution.findFirstOrThrow({ where: { tenantId: customer.tenantId } }))
          .id,
      ).toBe(executionAfterFailure.id)
      // Evidence for the earlier steps was not written twice; the later ones were added once.
      expect(
        await db.offboardingRevocationEvidence.count({ where: { tenantId: customer.tenantId } }),
      ).toBe(2 * 7)
    })

    it('a failed first step is unknown until a person can prove whether it changed data', async () => {
      const customer = await makeCustomer('uf')
      setOffboardingHooksForTests({
        beforeStep: (key) => {
          if (key === 'PUBLIC_ACCESS')
            throw Object.assign(new Error('simulated'), { code: 'SIMULATED' })
        },
      })
      const proposal = await propose({ tenantId: customer.tenantId, planId: customer.planId })
      const failed = await approve(proposal)
      expect(failed.status).toBe('FAILED')
      const stored = await db.operatorProposal.findUniqueOrThrow({
        where: { id: proposal.proposalId },
      })
      const resolved = await offboardingExecutionKind.resolveUnknown!(stored.args as any, {
        database: db,
        grant: allGrant,
        now: new Date(),
        actor: { type: 'HUMAN', id: adminId, role: 'PLATFORM_ADMIN' },
        proposalId: stored.id,
        operationId: stored.operationId,
      })
      expect(resolved.state).toBe('unknown')
    })

    it('refuses completion when a settled public-access step drifted before resume', async () => {
      const customer = await makeCustomer('drift')
      setOffboardingHooksForTests({
        beforeStep: (key) => {
          if (key === 'CONNECTIONS')
            throw Object.assign(new Error('simulated'), { code: 'SIMULATED' })
        },
      })
      expect(
        (await approve(await propose({ tenantId: customer.tenantId, planId: customer.planId })))
          .status,
      ).toBe('FAILED')
      await db.venue.updateMany({
        where: { id: customer.venueIds[0]!, tenantId: customer.tenantId },
        data: { isActive: true },
      })
      setOffboardingHooksForTests(null)
      const resumed = await approve(
        await propose({ tenantId: customer.tenantId, planId: customer.planId }),
      )
      expect(resumed.status).toBe('FAILED')
      expect(resumed.failureCode).toBe('PARTIALLY_APPLIED')
      expect(
        (
          await db.offboardingExecution.findFirstOrThrow({
            where: { tenantId: customer.tenantId },
          })
        ).status,
      ).toBe('IN_PROGRESS')
    })

    it('honours a plan that selected only some targets', async () => {
      const customer = await makeCustomer('targets', { targets: ['GUEST_LINKS'] })
      const applied = await approve(
        await propose({ tenantId: customer.tenantId, planId: customer.planId }),
      )
      expect(applied.status).toBe('APPLIED')
      expect(await stepStatuses(customer.planId, customer.tenantId)).toMatchObject({
        PUBLIC_ACCESS: 'COMPLETE',
        SCHEDULED_WORK: 'SKIPPED',
        CONNECTIONS: 'SKIPPED',
        MEMBER_ACCESS: 'SKIPPED',
      })
      expect(await db.venue.count({ where: { tenantId: customer.tenantId, isActive: true } })).toBe(
        0,
      )
      expect(
        (
          await db.agentRoutine.findFirstOrThrow({
            where: { id: customer.routineId, tenantId: customer.tenantId },
          })
        ).enabled,
      ).toBe(true)
      expect(
        (await db.tenant.findUniqueOrThrow({ where: { id: customer.tenantId } })).status,
      ).not.toBe('SUSPENDED')
    })

    it('an agent-identity-only plan leaves credentials and operator connections untouched', async () => {
      const customer = await makeCustomer('ai', { targets: ['AGENT_IDENTITIES'] })
      await db.agentIdentity.create({
        data: {
          tenantId: customer.tenantId,
          identityKey: `example-${suffix}-identity-only`,
          name: 'Example agent',
          agentType: 'example',
          accessScope: 'CLIENT',
          enabled: true,
          createdBy: adminId,
        },
      })
      const applied = await approve(
        await propose({ tenantId: customer.tenantId, planId: customer.planId }),
      )
      expect(applied.status).toBe('APPLIED')
      expect(await stepStatuses(customer.planId, customer.tenantId)).toMatchObject({
        CONNECTIONS: 'COMPLETE',
        MEMBER_ACCESS: 'SKIPPED',
      })
      expect(
        (
          await db.externalAccessCredential.findFirstOrThrow({
            where: { id: customer.credentialId, tenantId: customer.tenantId },
          })
        ).revokedAt,
      ).toBeNull()
      expect(
        (await db.operatorGrant.findUniqueOrThrow({ where: { id: customer.singleGrantId } }))
          .revokedAt,
      ).toBeNull()
      expect(
        await db.agentIdentity.count({ where: { tenantId: customer.tenantId, enabled: true } }),
      ).toBe(0)
    })

    it('concurrent customer offboardings do not restore each other to a shared operator grant', async () => {
      const first = await makeCustomer('sf')
      const second = await makeCustomer('ss')
      const shared = await makeGrant(
        false,
        [first.tenantId, second.tenantId, first.otherTenantId],
        allCapabilities,
      )
      const proposals = await Promise.all([
        propose({ tenantId: first.tenantId, planId: first.planId }),
        propose({ tenantId: second.tenantId, planId: second.planId }),
      ])
      const applied = await Promise.all(proposals.map((view) => approve(view)))
      expect(applied.map((row) => row.status)).toEqual(['APPLIED', 'APPLIED'])
      const grant = await db.operatorGrant.findUniqueOrThrow({ where: { id: shared.grantId } })
      expect(grant.tenantIds).toEqual([first.otherTenantId])
    })

    it('can be reverted: venues reopen and members return; the rest is listed for a person', async () => {
      const customer = await makeCustomer('revert')
      const statusBefore = (await db.tenant.findUniqueOrThrow({ where: { id: customer.tenantId } }))
        .status
      const applied = await approve(
        await propose({ tenantId: customer.tenantId, planId: customer.planId }),
      )
      expect(applied.status).toBe('APPLIED')
      await expect(guestLookup(customer.venueIds[0]!)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      })

      const revertView = await createRevertProposal(
        { proposalId: applied.id, operationId: randomUUID() },
        (raw) => raw as { proposalId: string; operationId: string },
        service(allGrant),
      )
      const reverted = await approve(revertView)
      expect(reverted.status).toBe('APPLIED')
      const result = reverted.result as any
      expect(result).toMatchObject({
        status: 'REINSTATED',
        venuesReopened: 2,
        membershipsRestored: 2,
      })
      expect(result.manualSteps.join(' ')).toMatch(/routines/iu)
      for (const venueId of customer.venueIds) {
        await expect(guestLookup(venueId)).resolves.toMatchObject({ name: expect.any(String) })
      }
      expect((await db.tenant.findUniqueOrThrow({ where: { id: customer.tenantId } })).status).toBe(
        statusBefore,
      )
      expect(
        await db.tenantMembership.count({
          where: { tenantId: customer.tenantId, status: { in: ['ACTIVE', 'INVITED'] } },
        }),
      ).toBe(2)
      // Things that need a person's decision are not switched back on.
      expect(
        (
          await db.agentRoutine.findFirstOrThrow({
            where: { id: customer.routineId, tenantId: customer.tenantId },
          })
        ).enabled,
      ).toBe(false)
      expect(
        (
          await db.externalAccessCredential.findFirstOrThrow({
            where: { id: customer.credentialId, tenantId: customer.tenantId },
          })
        ).revokedAt,
      ).not.toBeNull()
      expect(
        (await db.offboardingExecution.findFirstOrThrow({ where: { tenantId: customer.tenantId } }))
          .status,
      ).toBe('REINSTATED')

      // A reinstated plan is closed: offboard again with a new plan.
      await expect(
        propose({ tenantId: customer.tenantId, planId: customer.planId }),
      ).rejects.toMatchObject({ code: 'EXECUTION_CLOSED' })
    })
  },
)
