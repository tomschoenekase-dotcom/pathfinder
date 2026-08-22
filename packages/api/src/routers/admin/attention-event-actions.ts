import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

export const attentionEventActionInput = z
  .object({
    eventId: z.string().uuid(),
    scope: z.enum(['tenant', 'platform']).default('tenant'),
  })
  .strict()

type Input = z.infer<typeof attentionEventActionInput>

export function acknowledgeAttentionEvent(actorId: string, input: Input) {
  return withTenantIsolationBypass(async () => {
    const now = new Date()
    const change = {
      state: 'ACKNOWLEDGED' as const,
      readAt: now,
      readBy: actorId,
      acknowledgedAt: now,
      acknowledgedBy: actorId,
    }
    const updated =
      input.scope === 'platform'
        ? await db.platformOperationalEvent.updateMany({
            where: { id: input.eventId, state: 'OPEN' },
            data: change,
          })
        : await db.operationalEvent.updateMany({
            where: { id: input.eventId, state: 'OPEN' },
            data: change,
          })
    return { acknowledged: updated.count === 1 }
  })
}

export function resolveAttentionEvent(actorId: string, input: Input) {
  return withTenantIsolationBypass(async () => {
    const now = new Date()
    const change = {
      state: 'RESOLVED' as const,
      readAt: now,
      readBy: actorId,
      resolvedAt: now,
      resolvedBy: actorId,
    }
    const updated =
      input.scope === 'platform'
        ? await db.platformOperationalEvent.updateMany({
            where: { id: input.eventId, state: { in: ['OPEN', 'ACKNOWLEDGED'] } },
            data: change,
          })
        : await db.operationalEvent.updateMany({
            where: { id: input.eventId, state: { in: ['OPEN', 'ACKNOWLEDGED'] } },
            data: change,
          })
    return { resolved: updated.count === 1 }
  })
}
