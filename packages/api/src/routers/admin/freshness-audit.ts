import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const inputSchema = z
  .object({
    tenantId: z.string().min(1),
    venueId: z.string().min(1),
    queue: z.enum(['STALE_TRUSTED', 'PROVENANCE_GAP', 'DATE_SENSITIVE']),
    entityType: z.enum(['PLACE', 'KNOWLEDGE_ENTRY']).optional(),
    thresholdDays: z.number().int().min(1).max(365).default(60),
    horizonDays: z.number().int().min(1).max(90).default(14),
    cursor: z.object({ sortAt: z.string().datetime(), id: z.string().min(1) }).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .superRefine((value, ctx) => {
    if (value.queue !== 'DATE_SENSITIVE' && !value.entityType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entityType'],
        message: 'Content queues require an entity type',
      })
    }
    if (value.queue === 'DATE_SENSITIVE' && value.entityType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entityType'],
        message: 'Date-sensitive updates do not accept a content entity type',
      })
    }
  })

function page<T extends { id: string }>(rows: T[], limit: number, sortAt: (row: T) => Date) {
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor: hasMore && last ? { sortAt: sortAt(last).toISOString(), id: last.id } : null,
  }
}

function ascendingCursor(
  field: 'lastReviewedAt' | 'updatedAt' | 'expiresAt',
  cursor: { sortAt: string; id: string } | undefined,
) {
  if (!cursor) return {}
  const sortAt = new Date(cursor.sortAt)
  return {
    AND: [{ OR: [{ [field]: { gt: sortAt } }, { [field]: sortAt, id: { gt: cursor.id } }] }],
  }
}

const contentSelect = {
  id: true,
  name: true,
  sourceType: true,
  sourceName: true,
  sourceUrl: true,
  importedAt: true,
  humanConfirmedAt: true,
  lastReviewedAt: true,
  updatedAt: true,
} as const
const knowledgeSelect = {
  id: true,
  title: true,
  category: true,
  sourceType: true,
  sourceName: true,
  sourceUrl: true,
  importedAt: true,
  humanConfirmedAt: true,
  lastReviewedAt: true,
  updatedAt: true,
} as const

/** Read-only review queues derived from existing timestamps and provenance metadata. */
export const adminFreshnessAuditRouter = router({
  listFreshnessAudit: adminProcedure.input(inputSchema).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      const observedAt = new Date()
      const staleCutoff = new Date(observedAt.getTime() - input.thresholdDays * 86_400_000)
      const horizon = new Date(observedAt.getTime() + input.horizonDays * 86_400_000)

      if (input.queue === 'DATE_SENSITIVE') {
        const rows = await db.operationalUpdate.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: 'PUBLISHED',
            isActive: true,
            expiresAt: { lte: horizon },
            ...ascendingCursor('expiresAt', input.cursor),
          },
          orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
          take: input.limit + 1,
          select: {
            id: true,
            title: true,
            updateType: true,
            severity: true,
            priority: true,
            startsAt: true,
            expiresAt: true,
            publishedAt: true,
            updatedAt: true,
            place: { select: { id: true, name: true } },
          },
        })
        return {
          queue: input.queue,
          entityType: 'OPERATIONAL_UPDATE' as const,
          observedAt,
          thresholdDays: input.thresholdDays,
          horizonDays: input.horizonDays,
          ...page(rows, input.limit, (row) => row.expiresAt),
        }
      }

      const stale = input.queue === 'STALE_TRUSTED'
      if (input.entityType === 'PLACE') {
        const rows = await db.place.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            isActive: true,
            ...(stale
              ? { humanConfirmedAt: { not: null }, lastReviewedAt: { lte: staleCutoff } }
              : {
                  OR: [{ sourceType: 'UNKNOWN' }, { sourceName: null }, { lastReviewedAt: null }],
                }),
            ...ascendingCursor(stale ? 'lastReviewedAt' : 'updatedAt', input.cursor),
          },
          orderBy: stale
            ? [{ lastReviewedAt: 'asc' }, { id: 'asc' }]
            : [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: input.limit + 1,
          select: contentSelect,
        })
        return {
          queue: input.queue,
          entityType: input.entityType,
          observedAt,
          thresholdDays: input.thresholdDays,
          horizonDays: input.horizonDays,
          ...page(rows, input.limit, (row) => (stale ? row.lastReviewedAt! : row.updatedAt)),
        }
      }

      const rows = await db.venueKnowledgeEntry.findMany({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          isEnabled: true,
          ...(stale
            ? { humanConfirmedAt: { not: null }, lastReviewedAt: { lte: staleCutoff } }
            : { OR: [{ sourceType: 'UNKNOWN' }, { sourceName: null }, { lastReviewedAt: null }] }),
          ...ascendingCursor(stale ? 'lastReviewedAt' : 'updatedAt', input.cursor),
        },
        orderBy: stale
          ? [{ lastReviewedAt: 'asc' }, { id: 'asc' }]
          : [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: input.limit + 1,
        select: knowledgeSelect,
      })
      return {
        queue: input.queue,
        entityType: input.entityType,
        observedAt,
        thresholdDays: input.thresholdDays,
        horizonDays: input.horizonDays,
        ...page(rows, input.limit, (row) => (stale ? row.lastReviewedAt! : row.updatedAt)),
      }
    }),
  ),
})
