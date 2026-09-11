import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION,
  OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY,
} from '@pathfinder/contracts'

import { db, withTenantIsolationBypass } from '../index'
import { approvalParameterHash, consumeApprovalGrantInTransaction } from './approval-grants'

const confirmation = 'pathfinder_disposable_approval_grant_expiry_lock'
const enabled =
  process.env.RUN_APPROVAL_GRANT_EXPIRY_DB_INTEGRATION === '1' &&
  process.env.PATHFINDER_DISPOSABLE_APPROVAL_GRANT_CONFIRMATION === confirmation

function assertDisposableBoundary() {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '')
  const directDatabaseUrl = new URL(process.env.DIRECT_DATABASE_URL ?? '')
  if (
    databaseUrl.toString() !== directDatabaseUrl.toString() ||
    databaseUrl.hostname !== '127.0.0.1' ||
    !databaseUrl.port ||
    !/^\/pathfinder_disposable_approval_grant_expiry_[a-z0-9_]+$/u.test(databaseUrl.pathname)
  )
    throw new Error('Fixture requires one exact-name disposable IPv4 loopback database.')
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

async function waitForBlockedGrantWrite() {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const blocked = await db.$queryRaw<Array<{ pid: number }>>`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE ${'%approval_grants%'}
    `
    if (blocked.length) return
    await delay(25)
  }
  throw new Error('Consumption did not reach a PostgreSQL grant-row lock wait.')
}

describe.skipIf(!enabled)('approval grant expiry under a PostgreSQL row-lock wait', () => {
  afterAll(async () => db.$disconnect())

  it(
    'does not consume a grant when its row is held until after expiration',
    async () =>
      withTenantIsolationBypass(async () => {
        assertDisposableBoundary()
        const suffix = randomUUID().slice(0, 8)
        const tenantId = `tenant-grant-expiry-${suffix}`
        const venueId = `venue-grant-expiry-${suffix}`
        const identityId = `identity-grant-expiry-${suffix}`
        const runId = `run-grant-expiry-${suffix}`
        const actorId = `operator-grant-expiry-${suffix}`
        await db.tenant.create({
          data: { id: tenantId, name: 'Disposable grant tenant', slug: tenantId },
        })
        await db.venue.create({
          data: { id: venueId, tenantId, name: 'Disposable grant venue', slug: venueId },
        })
        await db.agentIdentity.create({
          data: {
            id: identityId,
            tenantId,
            venueId,
            identityKey: `grant-expiry.${suffix}`,
            name: 'Disposable grant agent',
            description: 'Exercises a grant expiry fence only.',
            agentType: 'OPERATIONS',
            accessScope: 'VENUE',
            accessCapabilities: [OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY],
            autonomyLevel: 'DRAFT',
            autonomousActions: [],
            enabled: true,
            createdBy: actorId,
          },
        })
        await db.agentRun.create({
          data: {
            id: runId,
            operationId: randomUUID(),
            tenantId,
            venueId,
            agentIdentityId: identityId,
            runType: 'OPERATIONS',
            requestedOperation: 'approval-grant.expiry-fixture',
            scopeSnapshot: { accessCapabilities: [OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY] },
            status: 'RUNNING',
            initiatedByType: 'HUMAN',
            initiatedById: actorId,
            startedAt: new Date(),
          },
        })
        const parameters = {
          clientId: tenantId,
          venueId,
          updateType: 'GENERAL_NOTICE',
          title: 'Expiry lock fixture',
        }
        const approvalRequest = await db.approvalRequest.create({
          data: {
            tenantId,
            venueId,
            agentIdentityId: identityId,
            agentRunId: runId,
            requestedByType: 'AGENT',
            requestedById: identityId,
            proposedAction: OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION,
            scopeSnapshot: { tenantId, venueId, effect: 'DRAFT_ONLY' },
            reason: 'Synthetic exact authority for the expiry lock regression.',
            riskCategory: 'LOW',
          },
        })
        const approvalDecision = await db.approvalDecision.create({
          data: {
            tenantId,
            venueId,
            approvalRequestId: approvalRequest.id,
            decision: 'APPROVED',
            decidedByType: 'HUMAN',
            decidedById: actorId,
            reason: 'Approve the exact disposable action once.',
          },
        })
        const expiresAt = new Date(Date.now() + 1_200)
        const grant = await db.approvalGrant.create({
          data: {
            operationId: randomUUID(),
            tenantId,
            venueId,
            approvalDecisionId: approvalDecision.id,
            agentIdentityId: identityId,
            actionName: OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION,
            capability: OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY,
            mode: 'ONE_SHOT',
            scope: { tenantId, venueId, effect: 'DRAFT_ONLY' },
            parameterHash: approvalParameterHash(parameters),
            constraints: {},
            issueReason: 'Disposable expiry fence only.',
            maxUses: 1,
            notBefore: new Date(Date.now() - 1_000),
            expiresAt,
            createdByType: 'HUMAN',
            createdById: actorId,
          },
        })

        let releaseLock: (() => void) | undefined
        let lockHeld: (() => void) | undefined
        const held = new Promise<void>((resolve) => {
          lockHeld = resolve
        })
        const release = new Promise<void>((resolve) => {
          releaseLock = resolve
        })
        const lockTransaction = db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM approval_grants WHERE id = ${grant.id} FOR UPDATE`
          lockHeld?.()
          await release
        })
        await held

        // No supplied `now`: the helper must use a database-time fence after its blocked write.
        const consumption = db.$transaction((tx) =>
          consumeApprovalGrantInTransaction(tx, {
            tenantId,
            venueId,
            approvalGrantId: grant.id,
            operationId: randomUUID(),
            actionName: OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION,
            capability: OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY,
            parameters,
            actor: {
              type: 'AGENT',
              actorId: identityId,
              role: 'AGENT',
              agentIdentityId: identityId,
              agentRunId: runId,
              workerId: `worker-${suffix}`,
              credentialId: `credential-${suffix}`,
              capability: OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY,
              modelProvider: 'deterministic',
              modelName: 'expiry-lock-fixture',
            },
          }),
        )
        // Attach a rejection handler before the blocker is released.
        const settled = consumption.then(
          (value) => ({ state: 'fulfilled' as const, value }),
          (error: unknown) => ({ state: 'rejected' as const, error }),
        )
        try {
          await waitForBlockedGrantWrite()
          await delay(Math.max(0, expiresAt.getTime() - Date.now()) + 150)
        } finally {
          releaseLock?.()
          await lockTransaction
        }

        await expect(settled).resolves.toMatchObject({
          state: 'rejected',
          error: { code: 'EXPIRED' },
        })
        await expect(
          db.approvalGrant.findUniqueOrThrow({
            where: { id: grant.id },
            select: { useCount: true },
          }),
        ).resolves.toEqual({ useCount: 0 })
        await expect(
          db.approvalGrantConsumption.count({ where: { approvalGrantId: grant.id } }),
        ).resolves.toBe(0)
      }),
    10_000,
  )
})
