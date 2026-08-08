import { logger } from '@pathfinder/config'
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import {
  enqueueAnalyticsEnrichment,
  enqueueDailyRollup,
  enqueueWeeklyDigest,
} from '@pathfinder/jobs'

export const SCHEDULED_TENANT_FANOUT_CONCURRENCY = 8
export const SCHEDULED_TENANT_PAGE_SIZE = 100

export type ScheduledTenantFanoutResult = {
  tenantCount: number
  acceptedCount: number
  skippedCount: number
  failedCount: number
}

export class ScheduledTenantFanoutError extends Error {
  readonly result: ScheduledTenantFanoutResult

  constructor(schedulerKind: string, result: ScheduledTenantFanoutResult) {
    super(`Scheduled ${schedulerKind} fan-out failed for ${result.failedCount} tenant(s).`)
    this.name = 'ScheduledTenantFanoutError'
    this.result = result
  }
}

async function executeScheduledTenantFanout(params: {
  schedulerKind: string
  tenantIds: string[]
  run: (tenantId: string) => Promise<'accepted' | 'skipped'>
  concurrency?: number
}): Promise<ScheduledTenantFanoutResult> {
  const concurrency = params.concurrency ?? SCHEDULED_TENANT_FANOUT_CONCURRENCY
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error('Scheduled tenant fan-out concurrency must be an integer from 1 to 100.')
  }

  let cursor = 0
  let acceptedCount = 0
  let skippedCount = 0
  let failedCount = 0
  const workers = Array.from(
    { length: Math.min(concurrency, params.tenantIds.length) },
    async () => {
      while (cursor < params.tenantIds.length) {
        const index = cursor
        cursor += 1
        const tenantId = params.tenantIds[index]!
        try {
          const outcome = await params.run(tenantId)
          if (outcome === 'accepted') acceptedCount += 1
          else skippedCount += 1
        } catch {
          failedCount += 1
          logger.warn({
            action: 'workers.scheduler.tenant_failed',
            schedulerKind: params.schedulerKind,
            tenantId,
          })
        }
      }
    },
  )

  await Promise.all(workers)
  const result = {
    tenantCount: params.tenantIds.length,
    acceptedCount,
    skippedCount,
    failedCount,
  }
  return result
}

function requireSuccessfulFanout(schedulerKind: string, result: ScheduledTenantFanoutResult): void {
  if (result.failedCount > 0) {
    logger.error({
      action: 'workers.scheduler.fanout_failed',
      schedulerKind,
      error: 'One or more scheduled tenant operations failed',
      ...result,
    })
    throw new ScheduledTenantFanoutError(schedulerKind, result)
  }
}

export async function runScheduledTenantFanout(params: {
  schedulerKind: string
  tenantIds: string[]
  run: (tenantId: string) => Promise<'accepted' | 'skipped'>
  concurrency?: number
}): Promise<ScheduledTenantFanoutResult> {
  const result = await executeScheduledTenantFanout(params)
  requireSuccessfulFanout(params.schedulerKind, result)
  return result
}

export function startOfUtcWeek(date: Date): Date {
  const start = new Date(date)
  const day = start.getUTCDay()
  const daysFromMonday = (day + 6) % 7
  start.setUTCDate(start.getUTCDate() - daysFromMonday)
  start.setUTCHours(0, 0, 0, 0)
  return start
}

export function endOfUtcWeek(date: Date): Date {
  const end = new Date(startOfUtcWeek(date))
  end.setUTCDate(end.getUTCDate() + 6)
  end.setUTCHours(23, 59, 59, 999)
  return end
}

export function startOfUtcDay(date: Date): Date {
  const result = new Date(date)
  result.setUTCHours(0, 0, 0, 0)
  return result
}

async function runActiveTenantFanout(params: {
  schedulerKind: string
  run: (tenantId: string) => Promise<'accepted' | 'skipped'>
}): Promise<ScheduledTenantFanoutResult> {
  const total: ScheduledTenantFanoutResult = {
    tenantCount: 0,
    acceptedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  }
  let afterId: string | undefined
  let hasAnotherPage = true

  while (hasAnotherPage) {
    const tenants = await db.tenant.findMany({
      where: {
        status: 'ACTIVE',
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: SCHEDULED_TENANT_PAGE_SIZE,
      select: { id: true },
    })
    if (tenants.length === 0) {
      hasAnotherPage = false
      continue
    }

    const page = await executeScheduledTenantFanout({
      schedulerKind: params.schedulerKind,
      tenantIds: tenants.map((tenant) => tenant.id),
      run: params.run,
    })
    total.tenantCount += page.tenantCount
    total.acceptedCount += page.acceptedCount
    total.skippedCount += page.skippedCount
    total.failedCount += page.failedCount
    afterId = tenants[tenants.length - 1]!.id
    hasAnotherPage = tenants.length === SCHEDULED_TENANT_PAGE_SIZE
  }

  requireSuccessfulFanout(params.schedulerKind, total)
  return total
}

async function prepareWeeklyDigest(
  tenantId: string,
  weekStart: Date,
  weekEnd: Date,
): Promise<{ id: string; status: 'PENDING' | 'PROCESSING' | 'COMPLETE' | 'FAILED' }> {
  return withTenantIsolationBypass(async () => {
    let digest = await db.weeklyDigest.upsert({
      where: { tenantId_weekStart: { tenantId, weekStart } },
      create: { tenantId, weekStart, weekEnd, status: 'PENDING' },
      update: {},
      select: { id: true, status: true },
    })

    if (digest.status !== 'FAILED') return digest

    const reset = await db.weeklyDigest.updateMany({
      where: { id: digest.id, tenantId, status: 'FAILED' },
      data: {
        status: 'PENDING',
        weekEnd,
        sessionCount: 0,
        messageCount: 0,
        insights: [],
        generatedAt: null,
      },
    })
    if (reset.count === 1) return { id: digest.id, status: 'PENDING' }

    const current = await db.weeklyDigest.findUnique({
      where: { tenantId_weekStart: { tenantId, weekStart } },
      select: { id: true, status: true },
    })
    if (!current) throw new Error('Weekly digest reconciliation could not be confirmed.')
    digest = current
    return digest
  })
}

export async function enqueueScheduledWeeklyDigests(now = new Date()): Promise<void> {
  const weekStart = startOfUtcWeek(now)
  const weekEnd = endOfUtcWeek(now)
  const result = await runActiveTenantFanout({
    schedulerKind: 'weekly-digest',
    run: async (tenantId) => {
      const digest = await prepareWeeklyDigest(tenantId, weekStart, weekEnd)
      if (digest.status === 'COMPLETE' || digest.status === 'PROCESSING') return 'skipped'
      await enqueueWeeklyDigest({
        tenantId,
        weekStart: weekStart.toISOString(),
        weekEnd: weekEnd.toISOString(),
        digestId: digest.id,
      })
      return 'accepted'
    },
  })
  logger.info({
    action: 'workers.weekly-digest.scheduler.completed',
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    ...result,
  })
}

export async function enqueueScheduledDailyRollups(now = new Date()): Promise<void> {
  const yesterday = startOfUtcDay(now)
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  const result = await runActiveTenantFanout({
    schedulerKind: 'daily-rollup',
    run: async (tenantId) => {
      await enqueueDailyRollup({ tenantId, date: yesterday.toISOString() })
      return 'accepted'
    },
  })
  logger.info({
    action: 'workers.daily-rollup.scheduler.completed',
    date: yesterday.toISOString(),
    ...result,
  })
}

export async function enqueueScheduledAnalyticsEnrichment(now = new Date()): Promise<void> {
  const yesterday = startOfUtcDay(now)
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  const result = await runActiveTenantFanout({
    schedulerKind: 'analytics-enrichment',
    run: async (tenantId) => {
      await enqueueAnalyticsEnrichment({ tenantId, date: yesterday.toISOString() })
      return 'accepted'
    },
  })
  logger.info({
    action: 'workers.analytics-enrichment.scheduler.completed',
    date: yesterday.toISOString(),
    ...result,
  })
}
