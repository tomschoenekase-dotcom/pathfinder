import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  createOperationalUpdateAction,
  db,
  lockContentVersionEntity,
  prepareSupportKnowledgeProposalAction,
  readSupportPackageFulfillment,
  scheduleOperationalUpdateAction,
  SupportPackageFulfillmentError,
  updateOperationalUpdateAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { mergeRouters, router } from '../core'
import type { TRPCContext } from '../context'
import { adminKnowledgeProposalsRouter } from '../routers/admin/knowledge-proposals'

const enabled =
  process.env.RUN_SUPPORT_TEMPORAL_COMPLETION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_support_temporal_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const app = router({ admin: mergeRouters(adminKnowledgeProposalsRouter) })

function context(userId: string): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId, activeTenantId: null, role: null, isPlatformAdmin: true },
  }
}

async function bounded<T>(promise: Promise<T>, message: string, timeoutMs = 5_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe.skipIf(!enabled)('support temporal completion on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('fulfills only a current live support-bound operational update and fences lock races', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `tenant-support-temporal-${suffix}`
    const venueId = `venue-support-temporal-${suffix}`
    const adminId = `admin-support-temporal-${suffix}`
    const identityId = `agent-support-temporal-${suffix}`
    const proposalId = randomUUID()
    const baseline = new Date()
    const futureStart = new Date(baseline.getTime() + 60 * 60_000)
    const futureExpiry = new Date(baseline.getTime() + 2 * 60 * 60_000)
    let supportRequestId = ''
    let supportVersion = 0
    let evidenceMessageId = ''

    await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: tenantId, name: 'Support temporal fixture', slug: tenantId },
      })
      await db.user.create({ data: { id: adminId, email: `${adminId}@example.test` } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Support temporal venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `support.temporal.${suffix}`,
          name: 'Support temporal specialist',
          agentType: 'CONTENT',
          accessScope: 'VENUE',
          accessCapabilities: ['content.draft'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: adminId,
        },
      })
      const request = await db.supportRequest.create({
        data: {
          tenantId,
          venueId,
          category: 'CONTENT_CORRECTION',
          status: 'IN_REVIEW',
          subject: 'Temporary east entrance closure',
          createdByKind: 'OPERATOR',
          createdById: adminId,
          updatedByKind: 'OPERATOR',
          updatedById: adminId,
        },
      })
      supportRequestId = request.id
      supportVersion = request.version
      await db.supportRequestAuditEvent.create({
        data: {
          tenantId,
          venueId,
          supportRequestId,
          requestVersion: supportVersion,
          eventType: 'STATUS_CHANGED',
          actorKind: 'OPERATOR',
          actorId: adminId,
          fromStatus: 'OPEN',
          toStatus: 'IN_REVIEW',
        },
      })
      const message = await db.supportMessage.create({
        data: {
          tenantId,
          venueId,
          supportRequestId,
          authorKind: 'CLIENT',
          authorId: adminId,
          visibility: 'CLIENT_VISIBLE',
          body: 'The east entrance will close temporarily.',
          submissionRequestId: randomUUID(),
          submissionInputHash: 'a'.repeat(64),
          requestVersion: supportVersion,
          clientVersion: request.clientVersion,
        },
      })
      evidenceMessageId = message.id
    })

    await prepareSupportKnowledgeProposalAction({
      operationId: proposalId,
      tenantId,
      venueId,
      supportRequestId,
      expectedVersion: supportVersion,
      evidenceMessageIds: [evidenceMessageId],
      correctionKind: 'CREATE_KNOWLEDGE',
      aiInference: 'The retained message describes a temporary operational condition.',
      proposedChange: 'The east entrance is temporarily closed.',
      reason: 'Prepare the exact temporal fact for human review.',
      confidence: 0.95,
      actor: {
        type: 'AGENT',
        actorId: identityId,
        role: 'AGENT',
        agentIdentityId: identityId,
        agentRunId: `run-${proposalId}`,
        workerId: `worker-${suffix}`,
        credentialId: `credential-${suffix}`,
        capability: 'knowledge:draft',
        idempotencyKey: proposalId,
        modelProvider: 'deterministic-fixture',
        modelName: 'support-temporal-v1',
      },
    })
    const pending = await db.knowledgeChangeProposal.findFirstOrThrow({
      where: { id: proposalId, tenantId, venueId },
      select: { updatedAt: true },
    })
    await app.createCaller(context(adminId)).admin.reviewKnowledgeProposal({
      operationId: randomUUID(),
      tenantId,
      venueId,
      proposalId,
      expectedUpdatedAt: pending.updatedAt.toISOString(),
      decision: 'APPROVED',
      reviewNote: 'Approve the temporal evidence while keeping scheduling separate.',
    })

    const fulfillmentInput = { tenantId, venueId, supportRequestId }
    await expect(
      readSupportPackageFulfillment(db as never, fulfillmentInput),
    ).rejects.toBeInstanceOf(SupportPackageFulfillmentError)

    const operationalUpdateId = randomUUID()
    const created = await createOperationalUpdateAction(
      {
        tenantId,
        id: operationalUpdateId,
        actor: { type: 'HUMAN', id: adminId, role: 'PLATFORM_ADMIN' },
        schedule: false,
        fields: {
          venueId,
          updateType: 'TEMPORARY_CLOSURE',
          severity: 'WARNING',
          priority: 'HIGH',
          title: 'East entrance temporarily closed',
          body: 'Use the west entrance.',
          startsAt: futureStart,
          expiresAt: futureExpiry,
        },
        finalizer: async ({ tx, update }) => {
          await tx.knowledgeProposalOperationalUpdateHandoff.create({
            data: {
              tenantId,
              venueId,
              proposalId,
              operationalUpdateId: update.id,
              previewHash: 'b'.repeat(64),
              createdBy: adminId,
            },
          })
        },
      },
      db,
    )
    await expect(
      readSupportPackageFulfillment(db as never, fulfillmentInput),
    ).rejects.toBeInstanceOf(SupportPackageFulfillmentError)

    const scheduled = await scheduleOperationalUpdateAction(
      {
        tenantId,
        actor: { type: 'HUMAN', id: adminId, role: 'PLATFORM_ADMIN' },
        id: operationalUpdateId,
        expectedUpdatedAt: created.update.updatedAt,
      },
      db,
    )
    await expect(
      readSupportPackageFulfillment(db as never, fulfillmentInput),
    ).rejects.toBeInstanceOf(SupportPackageFulfillmentError)

    const live = await updateOperationalUpdateAction(
      {
        tenantId,
        actor: { type: 'HUMAN', id: adminId, role: 'PLATFORM_ADMIN' },
        id: operationalUpdateId,
        expectedUpdatedAt: scheduled.update.updatedAt,
        schedule: false,
        fields: {
          venueId,
          updateType: 'TEMPORARY_CLOSURE',
          severity: 'WARNING',
          priority: 'HIGH',
          title: 'East entrance temporarily closed',
          body: 'Use the west entrance.',
          startsAt: new Date(baseline.getTime() - 60_000),
          expiresAt: futureExpiry,
        },
      },
      db,
    )
    const fulfilled = await readSupportPackageFulfillment(db as never, fulfillmentInput)
    expect(fulfilled).toMatchObject({
      contractVersion: 6,
      temporalFulfillment: {
        receipts: [
          expect.objectContaining({
            proposalId,
            sourceProposalId: proposalId,
            sourceRequestVersion: supportVersion,
            operationalUpdateId,
          }),
        ],
      },
    })

    let writerLocked!: () => void
    let releaseWriter!: () => void
    const locked = new Promise<void>((resolve) => {
      writerLocked = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })
    let raceExpiry!: Date
    const writer = db.$transaction(
      async (tx) => {
        await lockContentVersionEntity(tx, {
          tenantId,
          entityType: 'OPERATIONAL_UPDATE',
          entityId: operationalUpdateId,
        })
        raceExpiry = new Date(Date.now() + 1_500)
        const changed = await tx.operationalUpdate.updateMany({
          where: { id: operationalUpdateId, tenantId, venueId, updatedAt: live.update.updatedAt },
          data: {
            body: 'The closure window has elapsed.',
            expiresAt: raceExpiry,
          },
        })
        expect(changed.count).toBe(1)
        writerLocked()
        await bounded(release, 'Timed out waiting to release the operational-update writer')
        return raceExpiry
      },
      { timeout: 10_000 },
    )
    await bounded(locked, 'Timed out acquiring the operational-update writer lock')

    let readerLockAttempted!: () => void
    const attempted = new Promise<void>((resolve) => {
      readerLockAttempted = resolve
    })
    let reportReaderBackend!: (pid: number) => void
    const readerBackend = new Promise<number>((resolve) => {
      reportReaderBackend = resolve
    })
    const expectedEntityLockKey = `${tenantId}:OPERATIONAL_UPDATE:${operationalUpdateId}`
    const racedRead = db.$transaction(
      async (tx) => {
        const backendRows = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid() AS "pid"
        `
        reportReaderBackend(backendRows[0]?.pid ?? -1)
        const observedTx = new Proxy(tx, {
          get(txTarget, txProperty, txReceiver) {
            if (txProperty !== '$executeRaw') return Reflect.get(txTarget, txProperty, txReceiver)
            return (...args: unknown[]) => {
              if (args.some((argument) => argument === expectedEntityLockKey)) {
                readerLockAttempted()
              }
              return Reflect.apply(txTarget.$executeRaw, txTarget, args)
            }
          },
        })
        return await readSupportPackageFulfillment(observedTx as never, fulfillmentInput)
      },
      { timeout: 10_000 },
    )
    let coordinationError: unknown
    try {
      const [readerPid] = await bounded(
        Promise.all([readerBackend, attempted]),
        'Timed out waiting for the fulfillment reader to attempt the entity lock',
      )
      expect(readerPid).toBeGreaterThan(0)
      const launchClock = await db.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS "now"
      `
      expect(launchClock[0]?.now.getTime()).toBeLessThan(raceExpiry.getTime())
      const databaseClockDeadline = Date.now() + 5_000
      let databaseNow = new Date(0)
      let readerWaiting = false
      do {
        const clockRows = await db.$queryRaw<Array<{ now: Date; readerWaiting: boolean }>>`
          SELECT
            clock_timestamp() AS "now",
            EXISTS (
              SELECT 1
              FROM pg_stat_activity
              WHERE pid = ${readerPid}
                AND wait_event_type = 'Lock'
                AND wait_event = 'advisory'
            ) AS "readerWaiting"
        `
        databaseNow = clockRows[0]?.now ?? new Date(0)
        readerWaiting = clockRows[0]?.readerWaiting ?? false
        if (
          (!readerWaiting || databaseNow.getTime() < raceExpiry.getTime()) &&
          Date.now() >= databaseClockDeadline
        ) {
          throw new Error('Timed out proving the reader waited across operational-update expiry')
        }
        if (!readerWaiting || databaseNow.getTime() < raceExpiry.getTime()) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      } while (!readerWaiting || databaseNow.getTime() < raceExpiry.getTime())
    } catch (error) {
      coordinationError = error
    } finally {
      releaseWriter()
    }
    const committedExpiry = await writer
    if (coordinationError) {
      await racedRead.catch(() => undefined)
      throw coordinationError
    }
    expect(committedExpiry.getTime()).toBeLessThanOrEqual(Date.now())
    await expect(racedRead).rejects.toBeInstanceOf(SupportPackageFulfillmentError)
  })
})
