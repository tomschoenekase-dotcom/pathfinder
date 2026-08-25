import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { expireAbandonedVoiceSessions } from './voice-session-recovery'

function isExplicitDisposableDatabase(): boolean {
  if (process.env.RUN_VOICE_SESSION_RECOVERY_DB_INTEGRATION !== '1') return false
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

integrationDescribe('voice session recovery (disposable PostgreSQL integration)', () => {
  const runId = randomUUID()
  const tenantId = `voice-recovery-tenant-${runId}`
  const venueId = `voice-recovery-venue-${runId}`
  const visitorSessionId = `voice-recovery-visitor-${runId}`
  const now = new Date('2026-08-25T18:00:00.000Z')
  const old = new Date('2026-08-25T17:00:00.000Z')
  const recent = new Date('2026-08-25T17:59:00.000Z')
  const expiredReadyId = randomUUID()
  const abandonedAuthorizationId = randomUUID()
  const expiredActiveId = randomUUID()
  const retainedIds = [randomUUID(), randomUUID(), randomUUID()]

  const base = {
    tenantId,
    venueId,
    visitorSessionId,
    provider: 'openai',
    model: 'gpt-realtime',
    capability: 'realtime-voice',
    tier: 'quality',
    locale: 'en-US',
    voice: 'alloy',
    entitlementSnapshot: {},
    botConfigurationSnapshot: {},
    maxDurationSeconds: 600,
  }

  beforeAll(async () => {
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({ data: { id: tenantId, name: 'Voice recovery', slug: tenantId } })
      await db.venue.create({ data: { id: venueId, tenantId, name: 'Voice venue', slug: venueId } })
      await db.visitorSession.create({
        data: {
          id: visitorSessionId,
          tenantId,
          venueId,
          anonymousToken: `voice-recovery-token-${runId}`,
        },
      })
      await db.voiceSession.createMany({
        data: [
          {
            ...base,
            id: abandonedAuthorizationId,
            status: 'AUTHORIZING',
            createdAt: old,
            lastActiveAt: old,
          },
          {
            ...base,
            id: expiredReadyId,
            status: 'READY',
            createdAt: old,
            lastActiveAt: old,
            clientSecretExpiresAt: new Date('2026-08-25T17:30:00.000Z'),
          },
          {
            ...base,
            id: expiredActiveId,
            status: 'ACTIVE',
            createdAt: old,
            connectedAt: old,
            lastActiveAt: old,
          },
          {
            ...base,
            id: retainedIds[0]!,
            status: 'AUTHORIZING',
            createdAt: recent,
            lastActiveAt: recent,
          },
          {
            ...base,
            id: retainedIds[1]!,
            status: 'READY',
            createdAt: recent,
            lastActiveAt: recent,
            clientSecretExpiresAt: new Date('2026-08-25T18:05:00.000Z'),
          },
          {
            ...base,
            id: retainedIds[2]!,
            status: 'ACTIVE',
            createdAt: recent,
            connectedAt: recent,
            lastActiveAt: recent,
          },
        ],
      })
    })
  })

  afterAll(async () => {
    await withTenantIsolationBypass(async () => {
      await db.voiceSession.deleteMany({ where: { tenantId } })
      await db.visitorSession.deleteMany({ where: { tenantId } })
      await db.venue.deleteMany({ where: { tenantId } })
      // ContentVersion is append-only and restricts tenant deletion. The unique
      // test tenant is retained only until the disposable database is destroyed.
    })
    await db.$disconnect()
  })

  it('expires only abandoned lifecycle states and is replay-safe', async () => {
    const first = await expireAbandonedVoiceSessions({ now })
    const own = first.filter((session) => session.tenantId === tenantId)

    expect(new Set(own.map((session) => session.id))).toEqual(
      new Set([abandonedAuthorizationId, expiredReadyId, expiredActiveId]),
    )
    expect(own.find((session) => session.id === expiredActiveId)?.durationSeconds).toBe(600)

    const rows = await withTenantIsolationBypass(() =>
      db.voiceSession.findMany({
        where: { tenantId },
        select: {
          id: true,
          status: true,
          endedAt: true,
          fallbackToText: true,
          errorCode: true,
          durationSeconds: true,
        },
      }),
    )
    for (const id of [abandonedAuthorizationId, expiredReadyId, expiredActiveId]) {
      expect(rows.find((row) => row.id === id)).toMatchObject({
        status: 'EXPIRED',
        endedAt: now,
        fallbackToText: true,
        errorCode: 'SERVER_SESSION_EXPIRED',
      })
    }
    for (const id of retainedIds) {
      expect(rows.find((row) => row.id === id)?.status).not.toBe('EXPIRED')
    }

    const replay = await expireAbandonedVoiceSessions({ now })
    expect(replay.filter((session) => session.tenantId === tenantId)).toEqual([])
  })
})
