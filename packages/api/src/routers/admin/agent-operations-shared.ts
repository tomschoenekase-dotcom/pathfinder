import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { ApprovalDecisionActionError } from '@pathfinder/db'

const PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100

export const tenantScopeInput = z.object({
  tenantId: z.string().min(1),
  venueId: z.string().min(1).optional(),
})

export const pageInput = z.object({
  cursor: z
    .object({
      createdAt: z.string().datetime(),
      id: z.string().min(1),
    })
    .optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).default(PAGE_LIMIT),
})

export function createdBefore(cursor: z.infer<typeof pageInput>['cursor']) {
  if (!cursor) return undefined
  const createdAt = new Date(cursor.createdAt)
  return {
    AND: [{ OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }] }],
  }
}

export function pageResult<T extends { createdAt: Date; id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor: hasMore && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
  }
}

export function approvalState<
  T extends { decision: { decision: string } | null; expiresAt: Date | null },
>(request: T, now: Date) {
  if (request.decision) return request.decision.decision
  if (request.expiresAt && request.expiresAt <= now) return 'EXPIRED'
  return 'PENDING'
}

export function decisionError(error: unknown): never {
  if (error instanceof ApprovalDecisionActionError) {
    throw new TRPCError({ code: error.code, message: error.message })
  }
  throw error
}
