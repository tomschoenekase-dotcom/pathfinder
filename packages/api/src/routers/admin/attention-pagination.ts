import { z } from 'zod'

export type AttentionCursor = { createdAt: string; id: string }

export const ACTIVE_SUPPORT_REQUEST_STATUSES = [
  'OPEN',
  'IN_REVIEW',
  'WAITING_FOR_CLIENT',
  'PATCH_DRAFTED',
  'VALIDATING',
  'AWAITING_APPROVAL',
  'APPLYING',
] as const

const cursor = z.object({ createdAt: z.string().datetime(), id: z.string().min(1).max(191) })

export const attentionConsoleInput = z
  .object({
    limit: z.number().int().min(1).max(25).default(10),
    jobsCursor: cursor.optional(),
    evaluationsCursor: cursor.optional(),
    approvalsCursor: cursor.optional(),
    supportCursor: cursor.optional(),
    agentsCursor: cursor.optional(),
    questionsCursor: cursor.optional(),
    workingAgentsCursor: cursor.optional(),
    blockedAgentsCursor: cursor.optional(),
    completedAgentsCursor: cursor.optional(),
    outcomesCursor: cursor.optional(),
    eventsCursor: cursor.optional(),
    platformEventsCursor: cursor.optional(),
  })
  .default({ limit: 10 })

export function after(value?: AttentionCursor) {
  if (!value) return {}
  const createdAt = new Date(value.createdAt)
  return { AND: [{ OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: value.id } }] }] }
}

export function afterCondition(value?: AttentionCursor) {
  if (!value) return undefined
  const createdAt = new Date(value.createdAt)
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: value.id } }] }
}

export function page<T extends { id: string; createdAt: Date }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > limit && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
  }
}
