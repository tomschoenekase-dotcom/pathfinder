import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import {
  createOperationalUpdateAction,
  scheduleOperationalUpdateAction,
  updateOperationalUpdateAction,
  type OperationalUpdateFields,
} from './operational-update-actions'

const enabled =
  process.env.RUN_OPERATIONAL_CLOCK_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_operational_clock_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

async function crossExpiryBehindLock(key: string, expiresAt: Date, action: () => Promise<unknown>) {
  let unlock!: () => void
  let ready!: (pid: number) => void
  const gate = new Promise<void>((resolve) => {
    unlock = resolve
  })
  const acquired = new Promise<number>((resolve) => {
    ready = resolve
  })
  const holder = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      ready(rows[0]!.pid)
      await gate
    },
    { timeout: 10_000 },
  )
  const pid = await acquired
  let attempt: Promise<{ error?: unknown; succeeded?: boolean }> | undefined
  try {
    expect(Date.now()).toBeLessThan(expiresAt.getTime())
    attempt = action().then(
      () => ({ succeeded: true }),
      (error: unknown) => ({ error }),
    )
    let observedWaiter = false
    const deadline = Date.now() + 1_500
    while (Date.now() < deadline) {
      const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks held JOIN pg_locks waiting
            ON waiting.locktype = held.locktype
            AND waiting.database IS NOT DISTINCT FROM held.database
            AND waiting.classid = held.classid AND waiting.objid = held.objid
            AND waiting.objsubid = held.objsubid
          WHERE held.pid = ${pid} AND held.locktype = 'advisory'
            AND held.granted AND NOT waiting.granted
        ) AS blocked`
      if (rows[0]?.blocked) {
        observedWaiter = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(observedWaiter).toBe(true)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 30)),
    )
    expect(Date.now()).toBeGreaterThan(expiresAt.getTime())
  } finally {
    unlock()
    await holder
  }
  const result = await attempt
  expect(result).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  expect(result).not.toHaveProperty('succeeded')
}

describe.skipIf(!enabled)('operational update production clock on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('rejects expired admission after real entity and capacity lock waits', async () => {
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `clock-tenant-${suffix}`
    const venueId = `clock-venue-${suffix}`
    const userId = `clock-user-${suffix}`
    const actor = { type: 'HUMAN' as const, id: userId, role: 'PLATFORM_ADMIN' as const }
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({ data: { id: tenantId, name: 'Clock fixture', slug: tenantId } })
      await db.user.create({ data: { id: userId, email: `${userId}@example.test` } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Clock fixture venue', slug: venueId },
      })
    })
    const capacityKey = `operational-update-capacity:${tenantId}:${venueId}`
    for (const mode of [
      'create-capacity',
      'schedule-entity',
      'schedule-capacity',
      'update-draft-capacity',
      'update-active-capacity',
    ] as const) {
      const id = randomUUID()
      const expiresAt = new Date(Date.now() + 2_000)
      const fields: OperationalUpdateFields = {
        venueId,
        updateType: 'TEMPORARY_CLOSURE',
        severity: 'INFO',
        priority: 'NORMAL',
        title: mode,
        body: 'Synthetic closure window.',
        startsAt: new Date(Date.now() - 1_000),
        expiresAt,
      }
      if (mode === 'create-capacity') {
        await crossExpiryBehindLock(capacityKey, expiresAt, () =>
          createOperationalUpdateAction({ tenantId, actor, id, fields, schedule: true }),
        )
        expect(await db.operationalUpdate.count({ where: { id, tenantId } })).toBe(0)
        continue
      }
      const initial = await createOperationalUpdateAction({
        tenantId,
        actor,
        id,
        fields,
        schedule: mode === 'update-active-capacity',
      })
      const before = await db.operationalUpdate.findFirstOrThrow({
        where: { id, tenantId, venueId },
      })
      const key = mode === 'schedule-entity' ? `${tenantId}:OPERATIONAL_UPDATE:${id}` : capacityKey
      await crossExpiryBehindLock(key, expiresAt, () =>
        mode.startsWith('schedule-')
          ? scheduleOperationalUpdateAction({
              tenantId,
              actor,
              id,
              expectedUpdatedAt: initial.update.updatedAt,
            })
          : updateOperationalUpdateAction({
              tenantId,
              actor,
              id,
              expectedUpdatedAt: initial.update.updatedAt,
              fields: { ...fields, title: 'Must not be persisted' },
              schedule: mode === 'update-draft-capacity',
            }),
      )
      const after = await db.operationalUpdate.findFirstOrThrow({
        where: { id, tenantId, venueId },
      })
      expect(after).toEqual(before)
    }
  }, 30_000)
})
