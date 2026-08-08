import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '../client'

const integrationDescribe = process.env.RUN_ROLLUP_DB_INTEGRATION === '1' ? describe : describe.skip

type DailyRollupIdentity = {
  tenantId: string
  venueId: string
  date: Date
  metric: string
  placeId: string | null
  category: string | null
}

function createTwoPartyBarrier(timeoutMs = 3_000) {
  let arrivals = 0
  let release!: () => void
  let rejectBarrier!: (error: Error) => void
  let timeout: ReturnType<typeof setTimeout> | undefined
  const released = new Promise<void>((resolve, reject) => {
    release = resolve
    rejectBarrier = reject
  })

  return async () => {
    arrivals += 1
    if (arrivals === 1) {
      timeout = setTimeout(
        () => rejectBarrier(new Error('Timed out waiting for the competing transaction')),
        timeoutMs,
      )
    }
    if (arrivals === 2) {
      if (timeout) clearTimeout(timeout)
      release()
    }
    await released
  }
}

integrationDescribe('daily rollup logical uniqueness (PostgreSQL integration)', () => {
  const runId = randomUUID()
  const tenantId = `rollup-tenant-${runId}`
  const secondTenantId = `rollup-second-tenant-${runId}`
  const venueId = `rollup-venue-${runId}`
  const secondVenueId = `rollup-second-venue-${runId}`
  const secondTenantVenueId = `rollup-second-tenant-venue-${runId}`
  const placeId = `rollup-place-${runId}`
  const secondPlaceId = `rollup-second-place-${runId}`
  const day = new Date('2026-08-07T00:00:00.000Z')

  beforeAll(async () => {
    await db.tenant.createMany({
      data: [
        { id: tenantId, name: 'Rollup uniqueness fixture', slug: tenantId },
        {
          id: secondTenantId,
          name: 'Rollup uniqueness second fixture',
          slug: secondTenantId,
        },
      ],
    })
    await db.venue.createMany({
      data: [
        { id: venueId, tenantId, name: 'Rollup fixture venue', slug: venueId },
        {
          id: secondVenueId,
          tenantId,
          name: 'Rollup fixture second venue',
          slug: secondVenueId,
        },
        {
          id: secondTenantVenueId,
          tenantId: secondTenantId,
          name: 'Rollup second tenant venue',
          slug: secondTenantVenueId,
        },
      ],
    })
    await db.place.createMany({
      data: [
        {
          id: placeId,
          tenantId,
          venueId,
          name: 'Rollup fixture place',
          type: 'exhibit',
        },
        {
          id: secondPlaceId,
          tenantId,
          venueId,
          name: 'Rollup fixture second place',
          type: 'exhibit',
        },
      ],
    })
  })

  afterAll(async () => {
    await db.aiUsageDailyRollup.deleteMany({ where: { tenantId } })
    await db.aiUsageDailyRollup.deleteMany({ where: { tenantId: secondTenantId } })
    await db.dailyRollup.deleteMany({ where: { tenantId } })
    await db.dailyRollup.deleteMany({ where: { tenantId: secondTenantId } })
    await db.place.deleteMany({ where: { tenantId } })
    await db.venue.deleteMany({ where: { tenantId } })
    await db.venue.deleteMany({ where: { tenantId: secondTenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.tenant.delete({ where: { id: secondTenantId } })
    await db.$disconnect()
  })

  async function contendForDailyRollup(identity: DailyRollupIdentity) {
    const waitForBothDeletes = createTwoPartyBarrier()
    const replace = (value: number) =>
      db.$transaction(async (tx) => {
        await tx.dailyRollup.deleteMany({ where: identity })
        await waitForBothDeletes()
        await tx.dailyRollup.create({
          data: {
            id: randomUUID(),
            ...identity,
            value,
          },
        })
      })

    const results = await Promise.allSettled([replace(1), replace(2)])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: 'P2002' })
    expect(await db.dailyRollup.count({ where: identity })).toBe(1)

    await db.$transaction(async (tx) => {
      await tx.dailyRollup.deleteMany({ where: identity })
      await tx.dailyRollup.create({
        data: {
          id: randomUUID(),
          ...identity,
          value: 3,
        },
      })
    })

    await expect(db.dailyRollup.findMany({ where: identity })).resolves.toEqual([
      expect.objectContaining({ value: 3 }),
    ])
  }

  it('fences concurrent replacement for all nullable identity shapes', async () => {
    const shapes = [
      { metric: 'identity-null-null', placeId: null, category: null },
      { metric: 'identity-place-null', placeId, category: null },
      { metric: 'identity-null-category', placeId: null, category: 'family' },
      { metric: 'identity-place-category', placeId, category: 'family' },
    ]

    for (const shape of shapes) {
      await contendForDailyRollup({ tenantId, venueId, date: day, ...shape })
    }
  }, 10_000)

  it('allows every distinct logical identity dimension to coexist', async () => {
    const nextDay = new Date(day)
    nextDay.setUTCDate(nextDay.getUTCDate() + 1)

    await db.dailyRollup.createMany({
      data: [
        { tenantId, venueId, date: day, metric: 'coexist', value: 1 },
        { tenantId, venueId: secondVenueId, date: day, metric: 'coexist', value: 2 },
        {
          tenantId: secondTenantId,
          venueId: secondTenantVenueId,
          date: day,
          metric: 'coexist',
          value: 3,
        },
        { tenantId, venueId, date: nextDay, metric: 'coexist', value: 4 },
        { tenantId, venueId, date: day, metric: 'coexist-other-metric', value: 5 },
        { tenantId, venueId, date: day, metric: 'coexist', placeId, value: 6 },
        { tenantId, venueId, date: day, metric: 'coexist', placeId: secondPlaceId, value: 7 },
        { tenantId, venueId, date: day, metric: 'coexist', category: 'family', value: 8 },
        { tenantId, venueId, date: day, metric: 'coexist', category: 'history', value: 9 },
        {
          tenantId,
          venueId,
          date: day,
          metric: 'coexist',
          placeId,
          category: 'family',
          value: 10,
        },
      ],
    })

    expect(
      await db.dailyRollup.count({
        where: { tenantId, metric: { in: ['coexist', 'coexist-other-metric'] } },
      }),
    ).toBe(9)
    expect(
      await db.dailyRollup.count({
        where: { tenantId: secondTenantId, metric: 'coexist' },
      }),
    ).toBe(1)
  })

  it('retains the existing AI usage daily rollup uniqueness under contention', async () => {
    const waitForBothDeletes = createTwoPartyBarrier()
    const identity = {
      tenantId,
      venueId,
      date: day,
      feature: 'contention-fixture',
    }
    const replace = (requestCount: number) =>
      db.$transaction(async (tx) => {
        await tx.aiUsageDailyRollup.deleteMany({ where: identity })
        await waitForBothDeletes()
        await tx.aiUsageDailyRollup.create({
          data: {
            id: randomUUID(),
            ...identity,
            requestCount,
          },
        })
      })

    const results = await Promise.allSettled([replace(1), replace(2)])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: 'P2002' })
    expect(await db.aiUsageDailyRollup.count({ where: identity })).toBe(1)
  })
})
