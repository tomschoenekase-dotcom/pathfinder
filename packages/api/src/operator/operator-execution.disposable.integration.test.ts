/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed parsed output */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { createVenueAction, db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveOperatorConfig } from './config'
import { claimIsStale, reconcileProposal, recoverOperation } from './execution'
import { proposalEffect } from './outcome'
import type { VerifiedOperatorGrant } from './oauth'
import { createPlan } from './plans'
import { createOperatorRegistry, defaultVenueRead } from './registry'
import { OperatorNotFoundError } from './grants'
import { createKindRegistry, createProposal, finish } from './proposals'
import { OPERATOR_PROPOSAL_KINDS } from './kinds'

/**
 * Crash and recovery on a real disposable PostgreSQL. A crash is simulated by writing the exact
 * row state a dying worker would leave behind (and, where a domain write had committed, performing
 * that write), then asking the recovery path to resolve it. Invented names and example domains only.
 * Runs only against a database named pathfinder_disposable_*.
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
const tenantId = `exec-tenant-${suffix}`
const clientId = `opc_exec_${suffix}`
const owner = { type: 'HUMAN', id: 'user_owner', role: 'OWNER' } as const
const MINUTE = 60_000

let grant: VerifiedOperatorGrant
let revocableGrant: VerifiedOperatorGrant

async function makeGrant(): Promise<VerifiedOperatorGrant> {
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
  return {
    grantId: row.id,
    clientId,
    userId: 'user_owner',
    allTenants: false,
    tenantIds: [tenantId],
    capabilities: [...OperatorCapability.options],
  }
}

function service(forGrant = grant) {
  return { config, database: db, grant: forGrant, kinds, now: new Date(), requestId: randomUUID() }
}

async function propose(tool: string, args: Record<string, unknown>, forGrant = grant) {
  return createProposal(tool, { ...args, operationId: randomUUID() }, service(forGrant))
}

type Stuck = { claimed?: boolean; started?: boolean; lease?: 'expired' | 'live' }

/** Leaves a proposal exactly as a worker that died at a chosen point would. */
async function leaveStuck(proposalId: string, state: Stuck) {
  const now = Date.now()
  const claimed = state.claimed ?? true
  return db.operatorProposal.update({
    where: { id: proposalId },
    data: {
      status: 'APPROVED',
      decidedByUserId: 'user_owner',
      decidedAt: new Date(now - 10 * MINUTE),
      ...(claimed
        ? {
            applyClaimedAt: new Date(now - 10 * MINUTE),
            attempt: 1,
            fenceToken: 1,
            leaseExpiresAt: new Date(state.lease === 'live' ? now + 5 * MINUTE : now - 5 * MINUTE),
            applyStartedAt: state.started ? new Date(now - 10 * MINUTE) : null,
          }
        : {}),
    },
  })
}

const input = () => ({ requestId: randomUUID(), now: new Date() })
const venueCount = (slug: string) => db.venue.count({ where: { tenantId, slug } })

describe.skipIf(!enabled)(
  'operator crash recovery on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      await withTenantIsolationBypass(async () => {
        await db.tenant.create({
          data: { id: tenantId, name: `Example ${tenantId}`, slug: tenantId },
        })
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
      grant = await makeGrant()
      revocableGrant = await makeGrant()
    })

    afterAll(async () => {
      await withTenantIsolationBypass(() =>
        db.embeddingDispatch.deleteMany({ where: { tenantId } }),
      )
      await db.$disconnect()
    })

    it('judges a claim stale only after its lease, including rows from before leases existed', () => {
      const now = new Date('2026-09-30T12:00:00.000Z')
      const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE)
      expect(claimIsStale({ applyClaimedAt: null, leaseExpiresAt: null }, now)).toBe(false)
      expect(
        claimIsStale(
          { applyClaimedAt: ago(1), leaseExpiresAt: new Date(now.getTime() + MINUTE) },
          now,
        ),
      ).toBe(false)
      expect(claimIsStale({ applyClaimedAt: ago(10), leaseExpiresAt: ago(5) }, now)).toBe(true)
      expect(claimIsStale({ applyClaimedAt: ago(1), leaseExpiresAt: null }, now)).toBe(false)
      expect(claimIsStale({ applyClaimedAt: ago(30), leaseExpiresAt: null }, now)).toBe(true)
    })

    it('a worker that died before its domain write is released and the retry applies exactly once', async () => {
      const slug = `never-${suffix}`
      const view = await propose('venues.propose_create', { tenantId, name: 'Example Never', slug })
      await leaveStuck(view.proposalId, { started: false })
      expect(
        proposalEffect(
          await db.operatorProposal.findUniqueOrThrow({ where: { id: view.proposalId } }),
        ),
      ).toBe('none')

      // A live lease is left alone: the first worker may still be running.
      await leaveStuck(view.proposalId, { started: false, lease: 'live' })
      await recoverOperation(view.proposalId, dependencies, input())
      expect(
        (await db.operatorProposal.findUniqueOrThrow({ where: { id: view.proposalId } })).attempt,
      ).toBe(1)
      expect(await venueCount(slug)).toBe(0)

      await leaveStuck(view.proposalId, { started: false, lease: 'expired' })
      await recoverOperation(view.proposalId, dependencies, input())
      const done = await db.operatorProposal.findUniqueOrThrow({ where: { id: view.proposalId } })
      expect(done.status).toBe('APPLIED')
      expect(await venueCount(slug)).toBe(1)
      // Recovering again is a no-op: nothing is applied twice.
      await recoverOperation(view.proposalId, dependencies, input())
      expect(await venueCount(slug)).toBe(1)
    })

    it('a crash after the domain commit but before the result is recorded is reconciled, not repeated', async () => {
      const slug = `committed-${suffix}`
      const view = await propose('venues.propose_create', {
        tenantId,
        name: 'Example Committed',
        slug,
      })
      // The domain transaction committed (and wrote its receipt); the worker died before recording.
      await createVenueAction({
        tenantId,
        actor: owner,
        name: 'Example Committed',
        baseSlug: slug,
        callerSuppliedSlug: true,
        guideMode: 'non_location',
        initiallyActive: false,
        operationKey: (
          await db.operatorProposal.findUniqueOrThrow({ where: { id: view.proposalId } })
        ).operationId,
      })
      const stuck = await leaveStuck(view.proposalId, { started: true })
      expect(proposalEffect(stuck)).toBe('unknown')

      await recoverOperation(view.proposalId, dependencies, input())
      const done = await db.operatorProposal.findUniqueOrThrow({ where: { id: view.proposalId } })
      expect(done.status).toBe('APPLIED')
      expect(done.result).toMatchObject({ reconciled: true, draft: true })
      expect(await venueCount(slug)).toBe(1)
    })

    it('a crash after the write began but before it committed is released and applied once', async () => {
      const slug = `uncommitted-${suffix}`
      const view = await propose('venues.propose_create', {
        tenantId,
        name: 'Example Uncommitted',
        slug,
      })
      await leaveStuck(view.proposalId, { started: true })
      expect(await venueCount(slug)).toBe(0)
      await recoverOperation(view.proposalId, dependencies, input())
      expect(
        (await db.operatorProposal.findUniqueOrThrow({ where: { id: view.proposalId } })).status,
      ).toBe('APPLIED')
      expect(await venueCount(slug)).toBe(1)
    })

    it('holds an undecidable outcome for a human and never retries it', async () => {
      // Publishing has no receipt a reconciler can read, so a started-but-unrecorded apply is unknown.
      const venue = (
        await createVenueAction({
          tenantId,
          actor: owner,
          name: 'Example Hold',
          baseSlug: `hold-${suffix}`,
          callerSuppliedSlug: true,
          guideMode: 'non_location',
          initiallyActive: false,
        })
      ).record
      const view = await propose('venues.propose_publish', {
        tenantId,
        venueId: venue.id,
        expectedUpdatedAt: venue.updatedAt.toISOString(),
      })
      await leaveStuck(view.proposalId, { started: true })
      const settled = await reconcileProposal(view.proposalId, dependencies, input())
      expect(settled).toMatchObject({ status: 'FAILED', failureCode: 'OUTCOME_UNKNOWN' })
      expect(proposalEffect(settled)).toBe('unknown')
      await recoverOperation(view.proposalId, dependencies, input())
      expect(
        (await db.venue.findFirstOrThrow({ where: { id: venue.id, tenantId } })).isActive,
      ).toBe(false)
    })

    it('fences a stale worker: it cannot record a result after its lease was taken over', async () => {
      const venue = (
        await createVenueAction({
          tenantId,
          actor: owner,
          name: 'Example Fence',
          baseSlug: `fence-${suffix}`,
          callerSuppliedSlug: true,
          guideMode: 'non_location',
          initiallyActive: false,
        })
      ).record
      const view = await propose('venues.propose_publish', {
        tenantId,
        venueId: venue.id,
        expectedUpdatedAt: venue.updatedAt.toISOString(),
      })
      const stale = await leaveStuck(view.proposalId, { started: true })
      await reconcileProposal(view.proposalId, dependencies, input())
      const after = await db.operatorProposal.findUniqueOrThrow({ where: { id: view.proposalId } })
      expect(after.fenceToken).toBeGreaterThan(stale.fenceToken)
      // The stalled worker wakes up holding the old token and tries to record success.
      await finish(
        db,
        stale,
        'APPLIED',
        { result: { venueId: venue.id }, appliedAt: new Date() },
        randomUUID(),
        'user_owner',
      )
      const final = await db.operatorProposal.findUniqueOrThrow({ where: { id: view.proposalId } })
      expect(final.status).toBe('FAILED')
      expect(final.result).toBeNull()
    })

    it('resumes an interrupted plan: applied steps skipped, committed step reconciled, the rest applied', async () => {
      const slugs = [0, 1, 2].map((index) => `plan-${index}-${suffix}`)
      const plan = await createPlan(
        {
          operationId: randomUUID(),
          title: 'Example three venues',
          steps: slugs.map((slug, index) => ({
            tool: 'venues.propose_create',
            arguments: { tenantId, name: `Example Plan ${index}`, slug },
          })),
        },
        service(),
      )
      const steps = await db.operatorProposal.findMany({
        where: { planId: plan.proposalId },
        orderBy: { planStepIndex: 'asc' },
      })
      const now = Date.now()
      // Step 0 applied and recorded. Step 1 committed but the worker died before recording.
      const first = await createVenueAction({
        tenantId,
        actor: owner,
        name: 'Example Plan 0',
        baseSlug: slugs[0]!,
        callerSuppliedSlug: true,
        guideMode: 'non_location',
        initiallyActive: false,
        operationKey: steps[0]!.operationId,
      })
      await createVenueAction({
        tenantId,
        actor: owner,
        name: 'Example Plan 1',
        baseSlug: slugs[1]!,
        callerSuppliedSlug: true,
        guideMode: 'non_location',
        initiallyActive: false,
        operationKey: steps[1]!.operationId,
      })
      await db.operatorProposal.update({
        where: { id: steps[0]!.id },
        data: {
          status: 'APPLIED',
          decidedByUserId: 'user_owner',
          decidedAt: new Date(now - 10 * MINUTE),
          applyClaimedAt: new Date(now - 10 * MINUTE),
          applyStartedAt: new Date(now - 10 * MINUTE),
          attempt: 1,
          fenceToken: 1,
          result: { venueId: first.record.id, slug: slugs[0]!, draft: true, replayed: false },
        },
      })
      await leaveStuck(steps[1]!.id, { started: true })
      await db.operatorProposal.update({
        where: { id: steps[2]!.id },
        data: {
          status: 'APPROVED',
          decidedByUserId: 'user_owner',
          decidedAt: new Date(now - 10 * MINUTE),
        },
      })
      await db.operatorPlan.update({
        where: { id: plan.proposalId },
        data: {
          status: 'APPROVED',
          decidedByUserId: 'user_owner',
          decidedAt: new Date(now - 10 * MINUTE),
          applyClaimedAt: new Date(now - 10 * MINUTE),
          leaseExpiresAt: new Date(now - 5 * MINUTE),
          attempt: 1,
          fenceToken: 1,
        },
      })

      await recoverOperation(plan.proposalId, dependencies, input())

      const planRow = await db.operatorPlan.findUniqueOrThrow({ where: { id: plan.proposalId } })
      expect(planRow.status).toBe('APPLIED')
      const finalSteps = await db.operatorProposal.findMany({
        where: { planId: plan.proposalId },
        orderBy: { planStepIndex: 'asc' },
      })
      expect(finalSteps.map((step) => step.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED'])
      expect(finalSteps[1]!.result).toMatchObject({ reconciled: true })
      for (const slug of slugs) expect(await venueCount(slug)).toBe(1)
    })

    it('a plan whose step outcome is unknown stops there and does not run later steps', async () => {
      const venue = (
        await createVenueAction({
          tenantId,
          actor: owner,
          name: 'Example Stop',
          baseSlug: `stop-venue-${suffix}`,
          callerSuppliedSlug: true,
          guideMode: 'non_location',
          initiallyActive: false,
        })
      ).record
      const laterSlug = `stop-later-${suffix}`
      const plan = await createPlan(
        {
          operationId: randomUUID(),
          title: 'Example stop',
          steps: [
            {
              tool: 'venues.propose_publish',
              arguments: {
                tenantId,
                venueId: venue.id,
                expectedUpdatedAt: venue.updatedAt.toISOString(),
              },
            },
            {
              tool: 'venues.propose_create',
              arguments: { tenantId, name: 'Example Later', slug: laterSlug },
            },
          ],
        },
        service(),
      )
      const steps = await db.operatorProposal.findMany({
        where: { planId: plan.proposalId },
        orderBy: { planStepIndex: 'asc' },
      })
      const now = Date.now()
      await leaveStuck(steps[0]!.id, { started: true })
      await db.operatorProposal.update({
        where: { id: steps[1]!.id },
        data: {
          status: 'APPROVED',
          decidedByUserId: 'user_owner',
          decidedAt: new Date(now - MINUTE),
        },
      })
      await db.operatorPlan.update({
        where: { id: plan.proposalId },
        data: {
          status: 'APPROVED',
          decidedByUserId: 'user_owner',
          applyClaimedAt: new Date(now - 10 * MINUTE),
          leaseExpiresAt: new Date(now - 5 * MINUTE),
          attempt: 1,
          fenceToken: 1,
        },
      })
      await recoverOperation(plan.proposalId, dependencies, input())
      const planRow = await db.operatorPlan.findUniqueOrThrow({ where: { id: plan.proposalId } })
      expect(planRow).toMatchObject({ status: 'FAILED', failedStepIndex: 0 })
      const after = await db.operatorProposal.findMany({
        where: { planId: plan.proposalId },
        orderBy: { planStepIndex: 'asc' },
      })
      expect(after[0]).toMatchObject({ status: 'FAILED', failureCode: 'OUTCOME_UNKNOWN' })
      expect(after[1]).toMatchObject({ status: 'REJECTED', failureCode: 'PLAN_STOPPED' })
      expect(await venueCount(laterSlug)).toBe(0)
    })

    it('revocation between queueing and dispatch blocks the effect and reports no change', async () => {
      const slug = `revoked-${suffix}`
      const view = await propose(
        'venues.propose_create',
        { tenantId, name: 'Example Revoked', slug },
        revocableGrant,
      )
      // Approved and queued, then the connection is revoked before anything dispatches it.
      await db.operatorProposal.update({
        where: { id: view.proposalId },
        data: { status: 'APPROVED', decidedByUserId: 'user_owner', decidedAt: new Date() },
      })
      await db.operatorGrant.update({
        where: { id: revocableGrant.grantId },
        data: { revokedAt: new Date(), revokeReason: 'test' },
      })
      await recoverOperation(view.proposalId, dependencies, input())
      const row = await db.operatorProposal.findUniqueOrThrow({ where: { id: view.proposalId } })
      expect(row).toMatchObject({ status: 'FAILED', failureCode: 'GRANT_REVOKED' })
      expect(proposalEffect(row)).toBe('none')
      expect(await venueCount(slug)).toBe(0)
    })
    describe('controls', () => {
      const registry = createOperatorRegistry()
      async function control(
        name: 'operator.cancel_operation' | 'operator.recover_operation',
        originalOperationId: string,
        forGrant = grant,
      ) {
        return registry.callTool(
          name,
          { originalOperationId },
          {
            config,
            database: db,
            grant: forGrant,
            now: new Date(),
            requestId: randomUUID(),
            venueRead: defaultVenueRead(db),
          },
        ) as Promise<Record<string, any>>
      }
      const operationIdOf = async (proposalId: string) =>
        (await db.operatorProposal.findUniqueOrThrow({ where: { id: proposalId } })).operationId

      it('cancels pending and queued work, refuses running work, and never touches another connection', async () => {
        const slug = `cancel-${suffix}`
        const pending = await propose('venues.propose_create', {
          tenantId,
          name: 'Example Cancel',
          slug,
        })
        const operationId = await operationIdOf(pending.proposalId)
        await expect(
          control('operator.cancel_operation', operationId, revocableGrant),
        ).rejects.toBeInstanceOf(OperatorNotFoundError)
        const cancelled = await control('operator.cancel_operation', operationId)
        expect(cancelled).toMatchObject({
          status: 'REJECTED',
          failureCode: 'CANCELLED',
          effect: 'none',
          execution: { state: 'closed' },
        })
        // Cancelling again is a harmless no-op, and nothing was ever applied.
        expect((await control('operator.cancel_operation', operationId)).failureCode).toBe(
          'CANCELLED',
        )
        expect(await venueCount(slug)).toBe(0)

        const queued = await propose('venues.propose_create', {
          tenantId,
          name: 'Example Queued',
          slug: `queued-${suffix}`,
        })
        await leaveStuck(queued.proposalId, { claimed: false })
        expect(
          (await control('operator.cancel_operation', await operationIdOf(queued.proposalId)))
            .status,
        ).toBe('REJECTED')

        const running = await propose('venues.propose_create', {
          tenantId,
          name: 'Example Running',
          slug: `running-${suffix}`,
        })
        await leaveStuck(running.proposalId, { started: true, lease: 'live' })
        await expect(
          control('operator.cancel_operation', await operationIdOf(running.proposalId)),
        ).rejects.toMatchObject({ code: 'NOT_CANCELLABLE' })
      })

      it('cancels the unstarted rest of an approved plan and keeps the truth about what applied', async () => {
        const slugs = [0, 1].map((index) => `cplan-${index}-${suffix}`)
        const planOperationId = randomUUID()
        const plan = await createPlan(
          {
            operationId: planOperationId,
            title: 'Example cancel plan',
            steps: slugs.map((slug, index) => ({
              tool: 'venues.propose_create',
              arguments: { tenantId, name: `Example CPlan ${index}`, slug },
            })),
          },
          service(),
        )
        const steps = await db.operatorProposal.findMany({
          where: { planId: plan.proposalId },
          orderBy: { planStepIndex: 'asc' },
        })
        const created = await createVenueAction({
          tenantId,
          actor: owner,
          name: 'Example CPlan 0',
          baseSlug: slugs[0]!,
          callerSuppliedSlug: true,
          guideMode: 'non_location',
          initiallyActive: false,
          operationKey: steps[0]!.operationId,
        })
        await db.operatorProposal.update({
          where: { id: steps[0]!.id },
          data: {
            status: 'APPLIED',
            decidedByUserId: 'user_owner',
            attempt: 1,
            fenceToken: 1,
            applyClaimedAt: new Date(),
            applyStartedAt: new Date(),
            result: { venueId: created.record.id },
          },
        })
        await db.operatorProposal.update({
          where: { id: steps[1]!.id },
          data: { status: 'APPROVED', decidedByUserId: 'user_owner' },
        })
        await db.operatorPlan.update({
          where: { id: plan.proposalId },
          data: {
            status: 'APPROVED',
            decidedByUserId: 'user_owner',
            applyClaimedAt: new Date(Date.now() - 10 * MINUTE),
            leaseExpiresAt: new Date(Date.now() - 5 * MINUTE),
            attempt: 1,
            fenceToken: 1,
          },
        })
        const view = await control('operator.cancel_operation', planOperationId)
        expect(view).toMatchObject({ status: 'FAILED', effect: 'partial' })
        const after = await db.operatorProposal.findMany({
          where: { planId: plan.proposalId },
          orderBy: { planStepIndex: 'asc' },
        })
        expect(after.map((step) => [step.status, step.failureCode])).toEqual([
          ['APPLIED', null],
          ['REJECTED', 'CANCELLED'],
        ])
        expect(await venueCount(slugs[0]!)).toBe(1)
        expect(await venueCount(slugs[1]!)).toBe(0)
      })

      it('recovers through the tool and reports the new state', async () => {
        const slug = `tool-recover-${suffix}`
        const view = await propose('venues.propose_create', {
          tenantId,
          name: 'Example Tool',
          slug,
        })
        await leaveStuck(view.proposalId, { started: false })
        const recovered = await control(
          'operator.recover_operation',
          await operationIdOf(view.proposalId),
        )
        expect(recovered).toMatchObject({ status: 'APPLIED', effect: 'applied' })
        expect(await venueCount(slug)).toBe(1)
        await expect(
          control(
            'operator.recover_operation',
            await operationIdOf(view.proposalId),
            revocableGrant,
          ),
        ).rejects.toBeInstanceOf(OperatorNotFoundError)
      })
    })
  },
)
