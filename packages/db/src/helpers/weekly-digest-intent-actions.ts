import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type WeeklyDigestIntentActor =
  | { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
  | { type: 'SYSTEM'; id: string; role: 'SYSTEM' }
export type WeeklyDigestIntentClient = Pick<typeof db, '$transaction'>

export class WeeklyDigestIntentActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'WeeklyDigestIntentActionError'
  }
}

function invalid(message: string): never {
  throw new WeeklyDigestIntentActionError('INVALID_INPUT', message)
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

function validate(input: {
  tenantId: string
  weekStart: Date
  weekEnd: Date
  actor: WeeklyDigestIntentActor
}): void {
  if (!input.tenantId.trim()) invalid('Exact tenant scope is required.')
  if (
    !(input.weekStart instanceof Date) ||
    !(input.weekEnd instanceof Date) ||
    Number.isNaN(input.weekStart.getTime()) ||
    Number.isNaN(input.weekEnd.getTime()) ||
    input.weekStart.getTime() > input.weekEnd.getTime()
  ) {
    invalid('A valid ordered digest week is required.')
  }
  if (
    !input.actor ||
    !input.actor.id.trim() ||
    !(
      (input.actor.type === 'HUMAN' && input.actor.role === 'PLATFORM_ADMIN') ||
      (input.actor.type === 'SYSTEM' &&
        input.actor.role === 'SYSTEM' &&
        input.actor.id === 'weekly-digest-scheduler')
    )
  ) {
    invalid('A human platform administrator or identified system scheduler is required.')
  }
}

/**
 * Creates or reconciles the durable natural-key digest intent before queue I/O.
 * COMPLETE/PROCESSING work is never re-enqueued. FAILED work is reset with CAS;
 * PENDING work is an exact retry and remains enqueueable.
 */
export async function prepareWeeklyDigestIntentAction(
  input: {
    tenantId: string
    weekStart: Date
    weekEnd: Date
    actor: WeeklyDigestIntentActor
  },
  client: WeeklyDigestIntentClient = db,
) {
  validate(input)

  const attempt = () =>
    client.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: { id: true },
      })
      if (!tenant) throw new WeeklyDigestIntentActionError('NOT_FOUND', 'Client not found.')

      const existing = await tx.weeklyDigest.findUnique({
        where: { tenantId_weekStart: { tenantId: input.tenantId, weekStart: input.weekStart } },
        select: { id: true, status: true, weekEnd: true },
      })
      if (!existing) {
        const created = await tx.weeklyDigest.create({
          data: {
            tenantId: input.tenantId,
            weekStart: input.weekStart,
            weekEnd: input.weekEnd,
            status: 'PENDING',
          },
          select: { id: true, status: true, weekEnd: true },
        })
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: input.actor.id,
            actorRole: input.actor.role,
            action: 'weekly-digest.requested',
            targetType: 'WeeklyDigest',
            targetId: created.id,
            afterState: {
              weekStart: input.weekStart.toISOString(),
              weekEnd: input.weekEnd.toISOString(),
              status: 'PENDING',
            },
          },
          tx,
        )
        return { ...created, enqueueAllowed: true as const, outcome: 'CREATED' as const }
      }

      if (existing.weekEnd.getTime() !== input.weekEnd.getTime()) {
        throw new WeeklyDigestIntentActionError(
          'CONFLICT',
          'This digest week already has different boundaries.',
        )
      }
      if (existing.status !== 'FAILED') {
        return {
          ...existing,
          enqueueAllowed: existing.status === 'PENDING',
          outcome: 'REPLAYED' as const,
        }
      }

      const reset = await tx.weeklyDigest.updateMany({
        where: {
          id: existing.id,
          tenantId: input.tenantId,
          status: 'FAILED',
          weekEnd: input.weekEnd,
        },
        data: {
          status: 'PENDING',
          weekEnd: input.weekEnd,
          sessionCount: 0,
          messageCount: 0,
          insights: [],
          generatedAt: null,
        },
      })
      if (reset.count !== 1) {
        const current = await tx.weeklyDigest.findUnique({
          where: { tenantId_weekStart: { tenantId: input.tenantId, weekStart: input.weekStart } },
          select: { id: true, status: true, weekEnd: true },
        })
        if (!current) {
          throw new WeeklyDigestIntentActionError(
            'CONFLICT',
            'Digest reconciliation could not be confirmed.',
          )
        }
        if (current.weekEnd.getTime() !== input.weekEnd.getTime()) {
          throw new WeeklyDigestIntentActionError(
            'CONFLICT',
            'This digest week now has different boundaries.',
          )
        }
        return {
          ...current,
          enqueueAllowed: current.status === 'PENDING',
          outcome: 'RACED' as const,
        }
      }
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'weekly-digest.retry-requested',
          targetType: 'WeeklyDigest',
          targetId: existing.id,
          beforeState: { status: 'FAILED' },
          afterState: { status: 'PENDING' },
        },
        tx,
      )
      return {
        id: existing.id,
        status: 'PENDING' as const,
        weekEnd: input.weekEnd,
        enqueueAllowed: true as const,
        outcome: 'RESET' as const,
      }
    })

  try {
    return await attempt()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    return attempt()
  }
}
