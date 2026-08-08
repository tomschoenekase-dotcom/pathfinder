import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import {
  beginWelcomeEmailDeliveryAttempt,
  getWelcomeEmailDeliveryState,
  handleClerkEvent,
  isClerkWebhookReceiptConflictError,
  markWelcomeEmailDeliveryComplete,
} from './membership-sync'

function isExplicitDisposableDatabase(): boolean {
  if (process.env.RUN_CLERK_WEBHOOK_DB_INTEGRATION !== '1') return false
  try {
    const url = new URL(process.env.DATABASE_URL ?? '')
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const database = decodeURIComponent(url.pathname.slice(1))
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      ['127.0.0.1', '::1', 'localhost'].includes(host) &&
      url.port.length > 0 &&
      /^pathfinder_disposable_[a-z0-9_]+$/.test(database)
    )
  } catch {
    return false
  }
}

const integrationDescribe = isExplicitDisposableDatabase() ? describe : describe.skip

integrationDescribe('Clerk webhook receipts (disposable PostgreSQL integration)', () => {
  const runId = randomUUID()
  const tenantId = `clerk-receipt-tenant-${runId}`
  const userPrefix = `clerk-receipt-user-${runId}`
  const receiptPrefix = `clerk-receipt-event-${runId}`
  const hash = 'a'.repeat(64)
  const baseTimestamp = 1_700_000_000_000

  const membershipData = (userId: string, role = 'org:admin') => ({
    organization: { id: tenantId },
    public_user_data: {
      user_id: userId,
      first_name: 'Receipt',
      last_name: 'Test',
      email_addresses: [{ email_address: `${userId}@example.test` }],
    },
    role,
  })

  beforeAll(async () => {
    await db.tenant.create({
      data: { id: tenantId, name: 'Clerk receipt integration', slug: tenantId },
    })
  })

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.tenantMembership.deleteMany({ where: { tenantId } })
    await db.user.deleteMany({ where: { id: { startsWith: userPrefix } } })
    await db.clerkWebhookReceipt.deleteMany({
      where: { providerEventId: { startsWith: receiptPrefix } },
    })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it('lets exactly one of 16 same-identity callers mutate and audit', async () => {
    const userId = `${userPrefix}-same`
    const identity = { providerEventId: `${receiptPrefix}-same`, payloadHash: hash }
    const event = {
      type: 'organizationMembership.created' as const,
      data: membershipData(userId),
      timestamp: baseTimestamp,
    }

    const results = await Promise.all(
      Array.from({ length: 16 }, () => handleClerkEvent(event, identity)),
    )

    expect(results.filter((result) => !result.replayed)).toHaveLength(1)
    expect(results.filter((result) => result.replayed)).toHaveLength(15)
    await expect(
      db.clerkWebhookReceipt.count({ where: { providerEventId: identity.providerEventId } }),
    ).resolves.toBe(1)
    await expect(db.tenantMembership.count({ where: { tenantId, userId } })).resolves.toBe(1)
    await expect(db.auditLog.count({ where: { tenantId, actorId: userId } })).resolves.toBe(1)
  })

  it('deduplicates the state transition when different event IDs race', async () => {
    const userId = `${userPrefix}-different`
    const event = {
      type: 'organizationMembership.created' as const,
      data: membershipData(userId),
      timestamp: baseTimestamp + 10,
    }
    const identities = [1, 2].map((suffix) => ({
      providerEventId: `${receiptPrefix}-different-${suffix}`,
      payloadHash: String(suffix).repeat(64),
    }))

    await Promise.all(identities.map((identity) => handleClerkEvent(event, identity)))

    await expect(
      db.clerkWebhookReceipt.count({
        where: { providerEventId: { in: identities.map((identity) => identity.providerEventId) } },
      }),
    ).resolves.toBe(2)
    await expect(db.tenantMembership.count({ where: { tenantId, userId } })).resolves.toBe(1)
    await expect(db.auditLog.count({ where: { tenantId, actorId: userId } })).resolves.toBe(1)
  })

  it('rolls back receipt and membership when strict audit persistence fails, then retries cleanly', async () => {
    const userId = `${userPrefix}-audit-failure`
    const identity = { providerEventId: `${receiptPrefix}-audit-failure`, payloadHash: hash }
    const event = {
      type: 'organizationMembership.created' as const,
      data: membershipData(userId),
      timestamp: baseTimestamp + 20,
    }

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION pathfinder_test_reject_clerk_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.actor_id = '${userId}' THEN
          RAISE EXCEPTION 'synthetic audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await db.$executeRawUnsafe(`
      CREATE TRIGGER pathfinder_test_reject_clerk_audit
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION pathfinder_test_reject_clerk_audit();
    `)
    try {
      await expect(handleClerkEvent(event, identity)).rejects.toThrow()
      await expect(
        db.clerkWebhookReceipt.count({ where: { providerEventId: identity.providerEventId } }),
      ).resolves.toBe(0)
      await expect(db.tenantMembership.count({ where: { tenantId, userId } })).resolves.toBe(0)
      await expect(db.user.count({ where: { id: userId } })).resolves.toBe(0)
    } finally {
      await db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS pathfinder_test_reject_clerk_audit ON audit_logs;',
      )
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS pathfinder_test_reject_clerk_audit();')
    }

    await expect(handleClerkEvent(event, identity)).resolves.toEqual({
      replayed: false,
      welcomeEmailDeliveryId: expect.any(String),
    })
  })

  it('rejects a mismatched duplicate without changing membership or audit state', async () => {
    const userId = `${userPrefix}-mismatch`
    const identity = { providerEventId: `${receiptPrefix}-mismatch`, payloadHash: hash }
    await handleClerkEvent(
      {
        type: 'organizationMembership.created',
        data: membershipData(userId),
        timestamp: baseTimestamp + 30,
      },
      identity,
    )

    const error = await handleClerkEvent(
      {
        type: 'organizationMembership.updated',
        data: membershipData(userId, 'org:manager'),
        timestamp: baseTimestamp + 31,
      },
      { ...identity, payloadHash: 'b'.repeat(64) },
    ).catch((caught: unknown) => caught)

    expect(isClerkWebhookReceiptConflictError(error)).toBe(true)
    await expect(
      db.tenantMembership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId, userId }, tenantId },
        select: { role: true, status: true },
      }),
    ).resolves.toEqual({ role: 'OWNER', status: 'ACTIVE' })
    await expect(db.auditLog.count({ where: { tenantId, actorId: userId } })).resolves.toBe(1)
  })

  it('preserves update/delete audit parity while exact replays stay no-op', async () => {
    const userId = `${userPrefix}-lifecycle`
    const created = { providerEventId: `${receiptPrefix}-lifecycle-created`, payloadHash: hash }
    const updated = {
      providerEventId: `${receiptPrefix}-lifecycle-updated`,
      payloadHash: 'b'.repeat(64),
    }
    const deleted = {
      providerEventId: `${receiptPrefix}-lifecycle-deleted`,
      payloadHash: 'c'.repeat(64),
    }

    await handleClerkEvent(
      {
        type: 'organizationMembership.created',
        data: membershipData(userId),
        timestamp: baseTimestamp + 40,
      },
      created,
    )
    await handleClerkEvent(
      {
        type: 'organizationMembership.updated',
        data: membershipData(userId, 'org:manager'),
        timestamp: baseTimestamp + 41,
      },
      updated,
    )
    await expect(
      handleClerkEvent(
        {
          type: 'organizationMembership.updated',
          data: membershipData(userId, 'org:manager'),
          timestamp: baseTimestamp + 41,
        },
        updated,
      ),
    ).resolves.toEqual({ replayed: true, welcomeEmailDeliveryId: null })
    await handleClerkEvent(
      {
        type: 'organizationMembership.deleted',
        data: membershipData(userId, 'org:manager'),
        timestamp: baseTimestamp + 42,
      },
      deleted,
    )
    await expect(
      handleClerkEvent(
        {
          type: 'organizationMembership.deleted',
          data: membershipData(userId, 'org:manager'),
          timestamp: baseTimestamp + 42,
        },
        deleted,
      ),
    ).resolves.toEqual({ replayed: true, welcomeEmailDeliveryId: null })

    await expect(
      db.tenantMembership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId, userId }, tenantId },
        select: { role: true, status: true },
      }),
    ).resolves.toEqual({ role: 'MANAGER', status: 'REMOVED' })
    await expect(db.auditLog.count({ where: { tenantId, actorId: userId } })).resolves.toBe(3)
  })

  it('does not restore an older privileged role after a newer demotion', async () => {
    const userId = `${userPrefix}-stale-role`
    await handleClerkEvent(
      {
        type: 'organizationMembership.created',
        data: membershipData(userId),
        timestamp: baseTimestamp + 100,
      },
      { providerEventId: `${receiptPrefix}-stale-role-created`, payloadHash: hash },
    )
    await handleClerkEvent(
      {
        type: 'organizationMembership.updated',
        data: membershipData(userId, 'org:manager'),
        timestamp: baseTimestamp + 300,
      },
      { providerEventId: `${receiptPrefix}-stale-role-demoted`, payloadHash: 'b'.repeat(64) },
    )
    await handleClerkEvent(
      {
        type: 'organizationMembership.updated',
        data: membershipData(userId),
        timestamp: baseTimestamp + 200,
      },
      { providerEventId: `${receiptPrefix}-stale-role-owner`, payloadHash: 'c'.repeat(64) },
    )

    await expect(
      db.tenantMembership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId, userId }, tenantId },
        select: { role: true, status: true, clerkEventTimestamp: true },
      }),
    ).resolves.toEqual({
      role: 'MANAGER',
      status: 'ACTIVE',
      clerkEventTimestamp: BigInt(baseTimestamp + 300),
    })
    await expect(db.auditLog.count({ where: { tenantId, actorId: userId } })).resolves.toBe(2)
  })

  it('does not reactivate a membership from an update older than its removal', async () => {
    const userId = `${userPrefix}-stale-reactivation`
    await handleClerkEvent(
      {
        type: 'organizationMembership.created',
        data: membershipData(userId),
        timestamp: baseTimestamp + 400,
      },
      { providerEventId: `${receiptPrefix}-stale-delete-created`, payloadHash: hash },
    )
    await handleClerkEvent(
      {
        type: 'organizationMembership.deleted',
        data: membershipData(userId),
        timestamp: baseTimestamp + 600,
      },
      { providerEventId: `${receiptPrefix}-stale-delete-removed`, payloadHash: 'b'.repeat(64) },
    )
    await handleClerkEvent(
      {
        type: 'organizationMembership.updated',
        data: membershipData(userId),
        timestamp: baseTimestamp + 500,
      },
      { providerEventId: `${receiptPrefix}-stale-delete-update`, payloadHash: 'c'.repeat(64) },
    )

    await expect(
      db.tenantMembership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId, userId }, tenantId },
        select: { role: true, status: true, clerkEventTimestamp: true },
      }),
    ).resolves.toEqual({
      role: 'OWNER',
      status: 'REMOVED',
      clerkEventTimestamp: BigInt(baseTimestamp + 600),
    })
    await expect(db.auditLog.count({ where: { tenantId, actorId: userId } })).resolves.toBe(2)
  })

  it('gives non-webhook membership creation a fail-closed cutover baseline by default', async () => {
    const userId = `${userPrefix}-default-cutover`
    await db.user.create({
      data: { id: userId, email: `${userId}@example.test`, fullName: 'Default Cutover' },
    })
    await db.tenantMembership.create({
      data: { tenantId, userId, role: 'OWNER', status: 'ACTIVE' },
    })
    const initial = await db.tenantMembership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId, userId }, tenantId },
      select: { clerkEventTimestamp: true, clerkCursorIsCutoverBaseline: true },
    })
    expect(initial.clerkEventTimestamp).toBeGreaterThan(BigInt(baseTimestamp + 700))
    expect(initial.clerkCursorIsCutoverBaseline).toBe(true)

    await handleClerkEvent(
      {
        type: 'organizationMembership.updated',
        data: membershipData(userId, 'org:manager'),
        timestamp: baseTimestamp + 700,
      },
      { providerEventId: `${receiptPrefix}-default-cutover-manager`, payloadHash: hash },
    )
    await handleClerkEvent(
      {
        type: 'organizationMembership.updated',
        data: membershipData(userId),
        timestamp: baseTimestamp + 800,
      },
      { providerEventId: `${receiptPrefix}-default-cutover-owner`, payloadHash: 'b'.repeat(64) },
    )

    await expect(
      db.tenantMembership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId, userId }, tenantId },
        select: {
          role: true,
          status: true,
          clerkEventTimestamp: true,
          clerkCursorIsCutoverBaseline: true,
        },
      }),
    ).resolves.toEqual({
      role: 'MANAGER',
      status: 'ACTIVE',
      clerkEventTimestamp: initial.clerkEventTimestamp,
      clerkCursorIsCutoverBaseline: true,
    })
    await expect(db.auditLog.count({ where: { tenantId, actorId: userId } })).resolves.toBe(1)
  })

  it('accepts delayed pre-cutover reductions but rejects escalation and reactivation', async () => {
    const cutoff = baseTimestamp + 2_000
    const roleUserId = `${userPrefix}-cutover-role`
    const removedUserId = `${userPrefix}-cutover-removed`
    await db.user.createMany({
      data: [roleUserId, removedUserId].map((id) => ({
        id,
        email: `${id}@example.test`,
        fullName: 'Cutover Baseline',
      })),
    })
    await db.tenantMembership.createMany({
      data: [roleUserId, removedUserId].map((userId) => ({
        tenantId,
        userId,
        role: 'OWNER' as const,
        status: 'ACTIVE' as const,
        clerkEventTimestamp: BigInt(cutoff),
        clerkCursorIsCutoverBaseline: true,
      })),
    })

    await handleClerkEvent(
      {
        type: 'organizationMembership.updated',
        data: membershipData(roleUserId),
        timestamp: cutoff - 100,
      },
      { providerEventId: `${receiptPrefix}-cutover-owner-old`, payloadHash: hash },
    )
    await handleClerkEvent(
      {
        type: 'organizationMembership.updated',
        data: membershipData(roleUserId, 'org:manager'),
        timestamp: cutoff - 200,
      },
      { providerEventId: `${receiptPrefix}-cutover-manager-old`, payloadHash: 'b'.repeat(64) },
    )
    await handleClerkEvent(
      {
        type: 'organizationMembership.updated',
        data: membershipData(roleUserId),
        timestamp: cutoff - 50,
      },
      { providerEventId: `${receiptPrefix}-cutover-owner-newer`, payloadHash: 'c'.repeat(64) },
    )
    await handleClerkEvent(
      {
        type: 'organizationMembership.deleted',
        data: membershipData(removedUserId),
        timestamp: cutoff - 100,
      },
      { providerEventId: `${receiptPrefix}-cutover-delete-old`, payloadHash: 'd'.repeat(64) },
    )
    await handleClerkEvent(
      {
        type: 'organizationMembership.updated',
        data: membershipData(removedUserId),
        timestamp: cutoff - 50,
      },
      { providerEventId: `${receiptPrefix}-cutover-reactivate-old`, payloadHash: 'e'.repeat(64) },
    )

    await expect(
      db.tenantMembership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId, userId: roleUserId }, tenantId },
        select: {
          role: true,
          status: true,
          clerkEventTimestamp: true,
          clerkCursorIsCutoverBaseline: true,
        },
      }),
    ).resolves.toEqual({
      role: 'MANAGER',
      status: 'ACTIVE',
      clerkEventTimestamp: BigInt(cutoff),
      clerkCursorIsCutoverBaseline: true,
    })
    await expect(
      db.tenantMembership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId, userId: removedUserId }, tenantId },
        select: {
          role: true,
          status: true,
          clerkEventTimestamp: true,
          clerkCursorIsCutoverBaseline: true,
        },
      }),
    ).resolves.toEqual({
      role: 'OWNER',
      status: 'REMOVED',
      clerkEventTimestamp: BigInt(cutoff),
      clerkCursorIsCutoverBaseline: true,
    })
    await expect(
      db.auditLog.count({ where: { tenantId, actorId: { in: [roleUserId, removedUserId] } } }),
    ).resolves.toBe(2)
  })

  it('persists welcome attempt and completion state across an exact receipt replay', async () => {
    const userId = `${userPrefix}-welcome-state`
    const identity = { providerEventId: `${receiptPrefix}-welcome-state`, payloadHash: hash }
    const event = {
      type: 'organizationMembership.created' as const,
      data: membershipData(userId),
      timestamp: baseTimestamp + 3_000,
    }

    const first = await handleClerkEvent(event, identity)
    expect(first).toEqual({ replayed: false, welcomeEmailDeliveryId: expect.any(String) })
    const deliveryId = first.welcomeEmailDeliveryId!
    await expect(getWelcomeEmailDeliveryState(tenantId, deliveryId)).resolves.toEqual({
      complete: false,
      attemptedAt: null,
    })
    const attempt = await beginWelcomeEmailDeliveryAttempt(tenantId, deliveryId)
    expect(attempt.complete).toBe(false)
    expect(attempt.attemptedAt).toBeInstanceOf(Date)
    await markWelcomeEmailDeliveryComplete(tenantId, deliveryId)
    await expect(getWelcomeEmailDeliveryState(tenantId, deliveryId)).resolves.toEqual({
      complete: true,
      attemptedAt: attempt.attemptedAt,
    })
    await expect(handleClerkEvent(event, identity)).resolves.toEqual({
      replayed: true,
      welcomeEmailDeliveryId: deliveryId,
    })

    const receipt = await db.clerkWebhookReceipt.findUniqueOrThrow({
      where: { providerEventId: identity.providerEventId },
    })
    const serializedReceipt = JSON.stringify(receipt)
    expect(serializedReceipt).not.toContain(`${userId}@example.test`)
    expect(serializedReceipt).not.toContain(userId)
  })
})
