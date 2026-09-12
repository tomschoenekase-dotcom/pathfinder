import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { PrismaClient } from '@prisma/client'
import { expect, it } from 'vitest'
import { GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256 } from '@pathfinder/config/guest-conversation-disposition-policy'
import { db, recordGuestConversationDispositionAuthorization } from '@pathfinder/db'

import { processDailyRollupJob } from './processors/daily-rollup'

const enabled = process.env.RUN_DAILY_ROLLUP_DISPOSITION_DB_INTEGRATION === '1'

it.skipIf(!enabled)(
  'refuses actual cross-midnight disposed sources before replacing persisted numeric rollups',
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? '')
    const database = url.pathname.slice(1)
    // The runner supplies the exact descriptor only after the native owner releases it.
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.port).toBe(process.env.DISPOSITION_FIXTURE_PORT)
    expect(database).toBe(process.env.DISPOSITION_FIXTURE_DATABASE)
    expect(database).toMatch(/^pathfinder_disposable_guest_lifecycle_[a-f0-9]{12}$/u)
    function client(user: string, name = database) {
      const target = new URL(url)
      target.username = user
      target.pathname = `/${name}`
      target.searchParams.set('connection_limit', '1')
      return new PrismaClient({ datasourceUrl: target.toString() })
    }
    const control = client('guest_maintenance', 'postgres')
    const admin = client('postgres')
    const application = client('guest_application')
    const maintenance = client('guest_maintenance')
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `rollup-disposition-${suffix}`
    const venueId = `rollup-venue-${suffix}`
    const siblingVenueId = `rollup-sibling-${suffix}`
    const sessionId = `rollup-session-${suffix}`
    const operationId = randomUUID()
    const day = new Date('2024-01-02T00:00:00.000Z')
    const startedAt = new Date('2024-01-01T23:59:00.000Z')
    const crossedAt = new Date('2024-01-02T00:01:00.000Z')
    let closed = true
    try {
      expect(
        await control.$queryRaw`SELECT NOT datallowconn AS closed FROM pg_database WHERE datname = ${database}`,
      ).toEqual([{ closed: true }])
      await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS true`)
      closed = false
      await admin.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } })
      await admin.venue.createMany({
        data: [venueId, siblingVenueId].map((id) => ({ id, tenantId, name: id, slug: id })),
      })
      await admin.visitorSession.create({
        data: {
          id: sessionId,
          tenantId,
          venueId,
          anonymousToken: randomUUID(),
          experienceScope: 'PUBLIC',
          startedAt,
          lastActiveAt: crossedAt,
        },
      })
      const message = await admin.message.create({
        data: {
          tenantId,
          venueId,
          sessionId,
          sessionSequence: 0,
          role: 'user',
          content: 'Synthetic cross-midnight guest source',
          createdAt: crossedAt,
        },
      })
      await admin.analyticsEvent.create({
        data: {
          tenantId,
          venueId,
          sessionId,
          userMessageId: message.id,
          eventType: 'message.received',
          occurredAt: crossedAt,
          metadata: { synthetic: true },
        },
      })
      await admin.dailyRollup.createMany({
        data: [
          { tenantId, venueId, date: day, metric: 'sessions', value: 71 },
          { tenantId, venueId, date: day, metric: 'messages', value: 113 },
          { tenantId, venueId: siblingVenueId, date: day, metric: 'messages', value: 29 },
        ],
      })
      await admin.aiUsageDailyRollup.create({
        data: {
          tenantId,
          venueId,
          date: day,
          feature: 'guest-chat',
          requestCount: 17,
          totalTokens: 401,
          estimatedCostUsd: '0.12345678',
        },
      })
      const readSentinels = async () => ({
        daily: await admin.dailyRollup.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
        cost: await admin.aiUsageDailyRollup.findMany({
          where: { tenantId },
          orderBy: { id: 'asc' },
        }),
      })
      const before = await readSentinels()
      expect(before.daily).toHaveLength(3)
      expect(before.cost).toHaveLength(1)
      expect(
        await admin.visitorSession.count({ where: { tenantId, startedAt: { gte: day } } }),
      ).toBe(0)
      expect(await admin.message.count({ where: { tenantId, createdAt: { gte: day } } })).toBe(1)
      expect(
        await admin.analyticsEvent.count({ where: { tenantId, occurredAt: { gte: day } } }),
      ).toBe(1)

      const policyVersion = 'guest-conversations-terminal-text-v1'
      const basis = { kind: 'RETENTION_EXPIRY' as const }
      const authorized = await recordGuestConversationDispositionAuthorization(
        {
          request: {
            version: 'guest-conversation-disposition-v1',
            operationId,
            tenantId,
            venueId,
            sessionId,
            expectedPolicyVersion: policyVersion,
            expectedPolicySha256: GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
            basis,
          },
          authority: {
            version: 'guest-disposition-authority-v1',
            actorId: 'synthetic-rollup-operator',
            actorRole: 'PLATFORM_ADMIN',
            policyVersion,
            policySha256: GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
            retentionDays: 365,
            holdAssessment: { status: 'NO_KNOWN_HOLD', referenceSha256: '8'.repeat(64) },
            basis,
          },
        },
        application,
      )
      await Promise.all([db.$disconnect(), admin.$disconnect(), application.$disconnect()])
      await maintenance.$queryRaw`SELECT pg_backend_pid()`
      await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS false`)
      closed = true
      const sealed = await maintenance.$queryRaw<Array<{ result: { affected: unknown } }>>`
        SELECT public.pathfinder_seal_guest_disposition(${operationId}::uuid, ${authorized.requestSha256}) AS result
      `
      const applied = await maintenance.$queryRaw<Array<{ result: { affected: unknown } }>>`
        SELECT public.pathfinder_apply_guest_disposition(${operationId}::uuid, ${authorized.requestSha256}, ${'c'.repeat(64)}) AS result
      `
      expect(sealed[0]?.result.affected).toMatchObject({
        sessions: 1,
        messages: 1,
        analyticsEvents: 1,
      })
      expect(applied[0]?.result.affected).toEqual(sealed[0]?.result.affected)
      await maintenance.$disconnect()
      await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS true`)
      closed = false
      expect(await readSentinels()).toEqual(before)
      expect(
        await admin.visitorSession.findUnique({
          where: { id: sessionId },
          select: { startedAt: true, dispositionOperationId: true },
        }),
      ).toEqual({ startedAt, dispositionOperationId: operationId })
      await expect(processDailyRollupJob({ tenantId, date: day.toISOString() })).rejects.toThrow(
        'DAILY_ROLLUP_DISPOSED_SOURCE',
      )
      const after = await readSentinels()
      expect(after).toEqual(before)
      expect(
        await admin.jobRecord.findMany({ where: { tenantId }, select: { status: true } }),
      ).toEqual([{ status: 'FAILED' }])
      const output = process.env.PATHFINDER_DISPOSABLE_PROOF_OUTPUT
      if (output)
        writeFileSync(
          output,
          JSON.stringify(
            {
              authorizedState: authorized.state,
              sealedAffected: sealed[0]?.result.affected,
              appliedAffected: applied[0]?.result.affected,
              startedAt,
              crossedAt,
              targetDay: day,
              errorCode: 'DAILY_ROLLUP_DISPOSED_SOURCE',
              before,
              after,
              numericRowsUnchanged: true,
              actualProcessorAndPrisma: true,
            },
            null,
            2,
          ),
          { flag: 'wx' },
        )
    } finally {
      await Promise.allSettled([
        db.$disconnect(),
        admin.$disconnect(),
        application.$disconnect(),
        maintenance.$disconnect(),
      ])
      if (!closed)
        await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS false`)
      expect(
        await control.$queryRaw`SELECT NOT datallowconn AS closed FROM pg_database WHERE datname = ${database}`,
      ).toEqual([{ closed: true }])
      await control.$disconnect()
    }
  },
  60_000,
)
