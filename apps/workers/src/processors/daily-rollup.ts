import { logger } from '@pathfinder/config'
import { db, withTenantIsolationBypass, writeJobRecord, updateJobRecord } from '@pathfinder/db'
import type { DailyRollupJobPayload } from '@pathfinder/jobs'

type RollupRow = {
  tenantId: string
  venueId: string
  date: Date
  metric: string
  value: number
  placeId?: string
}

function startOfUtcDay(date: Date): Date {
  const result = new Date(date)

  result.setUTCHours(0, 0, 0, 0)

  return result
}

function endOfUtcDay(date: Date): Date {
  const result = startOfUtcDay(date)

  result.setUTCDate(result.getUTCDate() + 1)

  return result
}

function normalizeForSearch(value: string): string {
  return value.toLocaleLowerCase()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countPlaceMentions(
  messages: Array<{ content: string }>,
  places: Array<{ id: string; name: string }>,
): { mentionCounts: Map<string, number>; uniqueMentionCount: number } {
  const mentionCounts = new Map<string, number>()

  for (const place of places) {
    const matcher = new RegExp(`\\b${escapeRegExp(place.name)}\\b`, 'i')
    let count = 0

    for (const message of messages) {
      if (matcher.test(message.content)) {
        count += 1
      }
    }

    if (count > 0) {
      mentionCounts.set(place.id, count)
    }
  }

  return {
    mentionCounts,
    uniqueMentionCount: mentionCounts.size,
  }
}

async function buildTenantRollups(payload: DailyRollupJobPayload): Promise<RollupRow[]> {
  const date = startOfUtcDay(new Date(payload.date))
  const nextDate = endOfUtcDay(date)

  return withTenantIsolationBypass(async () => {
    const venues = await db.venue.findMany({
      where: {
        tenantId: payload.tenantId,
        isActive: true,
      },
      select: {
        id: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    })

    const rollups: RollupRow[] = []

    for (const venue of venues) {
      const [sessionCount, messageCount, messages, places] = await Promise.all([
        db.visitorSession.count({
          where: {
            tenantId: payload.tenantId,
            venueId: venue.id,
            startedAt: {
              gte: date,
              lt: nextDate,
            },
          },
        }),
        db.message.count({
          where: {
            tenantId: payload.tenantId,
            createdAt: {
              gte: date,
              lt: nextDate,
            },
            session: {
              venueId: venue.id,
            },
          },
        }),
        db.message.findMany({
          where: {
            tenantId: payload.tenantId,
            createdAt: {
              gte: date,
              lt: nextDate,
            },
            session: {
              venueId: venue.id,
            },
          },
          select: {
            content: true,
          },
        }),
        db.place.findMany({
          where: {
            tenantId: payload.tenantId,
            venueId: venue.id,
            isActive: true,
          },
          select: {
            id: true,
            name: true,
          },
        }),
      ])

      const normalizedMessages = messages.map((message) => ({
        content: normalizeForSearch(message.content),
      }))
      const normalizedPlaces = places.map((place) => ({
        ...place,
        name: normalizeForSearch(place.name),
      }))
      const { mentionCounts, uniqueMentionCount } = countPlaceMentions(
        normalizedMessages,
        normalizedPlaces,
      )

      rollups.push(
        {
          tenantId: payload.tenantId,
          venueId: venue.id,
          date,
          metric: 'sessions',
          value: sessionCount,
        },
        {
          tenantId: payload.tenantId,
          venueId: venue.id,
          date,
          metric: 'messages',
          value: messageCount,
        },
        {
          tenantId: payload.tenantId,
          venueId: venue.id,
          date,
          metric: 'unique_place_mentions',
          value: uniqueMentionCount,
        },
      )

      for (const [placeId, value] of mentionCounts.entries()) {
        rollups.push({
          tenantId: payload.tenantId,
          venueId: venue.id,
          date,
          metric: 'place_mentions',
          placeId,
          value,
        })
      }
    }

    return rollups
  })
}

export async function processDailyRollupJob(
  payload: DailyRollupJobPayload,
  bullJobId?: string | null,
): Promise<void> {
  const startedAt = new Date()
  const date = startOfUtcDay(new Date(payload.date))
  const nextDate = endOfUtcDay(date)

  const jobRecordId = await writeJobRecord({
    queue: 'daily-rollup',
    jobName: 'daily-rollup-process',
    bullJobId: bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
  })

  try {
    const rollups = await buildTenantRollups(payload)

    await withTenantIsolationBypass(async () => {
      await db.$transaction(async (tx) => {
        await tx.dailyRollup.deleteMany({
          where: {
            tenantId: payload.tenantId,
            date: {
              gte: date,
              lt: nextDate,
            },
          },
        })

        if (rollups.length > 0) {
          await tx.dailyRollup.createMany({
            data: rollups.map((rollup) => ({
              tenantId: rollup.tenantId,
              venueId: rollup.venueId,
              date: rollup.date,
              metric: rollup.metric,
              value: rollup.value,
              ...(rollup.placeId ? { placeId: rollup.placeId } : {}),
            })),
          })
        }
      })
    })

    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.daily-rollup.completed',
      tenantId: payload.tenantId,
      date: date.toISOString(),
      rowCount: rollups.length,
    })
  } catch (error) {
    await updateJobRecord(jobRecordId, {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Unknown daily rollup error',
    })

    logger.error({
      action: 'workers.daily-rollup.failed',
      tenantId: payload.tenantId,
      date: date.toISOString(),
      error: error instanceof Error ? error.message : 'Unknown daily rollup error',
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })

    throw error
  }
}
