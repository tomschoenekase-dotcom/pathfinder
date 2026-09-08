import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass, writeAuditLogStrict } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const visitorFeedbackHazardEvidenceInput = z.object({ eventId: z.string().uuid() }).strict()

type Dependencies = {
  readEvent(id: string): Promise<{
    id: string
    tenantId: string
    venueId: string | null
    eventType: string
    linkedObjectType: string | null
    linkedObjectId: string | null
    occurrenceCount: number
    lastOccurredAt: Date
  } | null>
  readFeedback(input: { id: string; tenantId: string; venueId: string }): Promise<{
    id: string
    rating: 'HELPFUL' | 'NOT_HELPFUL'
    reason: string | null
    updatedAt: Date
    sessionId: string
    message: {
      id: string
      role: string
      content: string
      createdAt: Date
    }
  } | null>
  audit: typeof writeAuditLogStrict
}

const dependencies: Dependencies = {
  readEvent: (id) =>
    withTenantIsolationBypass(() =>
      db.operationalEvent.findUnique({
        where: { id },
        select: {
          id: true,
          tenantId: true,
          venueId: true,
          eventType: true,
          linkedObjectType: true,
          linkedObjectId: true,
          occurrenceCount: true,
          lastOccurredAt: true,
        },
      }),
    ),
  readFeedback: ({ id, tenantId, venueId }) =>
    withTenantIsolationBypass(() =>
      db.messageFeedback.findFirst({
        where: { id, tenantId, venueId },
        select: {
          id: true,
          rating: true,
          reason: true,
          updatedAt: true,
          sessionId: true,
          message: {
            select: {
              id: true,
              role: true,
              content: true,
              createdAt: true,
            },
          },
        },
      }),
    ),
  audit: writeAuditLogStrict,
}

export async function readVisitorFeedbackHazardEvidence(
  input: z.infer<typeof visitorFeedbackHazardEvidenceInput>,
  actorId: string,
  deps: Dependencies = dependencies,
) {
  let event: Awaited<ReturnType<Dependencies['readEvent']>>
  try {
    event = await deps.readEvent(input.eventId)
  } catch {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Visitor feedback evidence could not be read.',
    })
  }
  if (!event)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Operational event was not found.' })
  if (
    event.eventType !== 'visitor-feedback.potential-urgent-hazard' ||
    event.linkedObjectType !== 'MessageFeedback' ||
    !event.linkedObjectId ||
    !event.venueId
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This alert does not contain exact visitor feedback evidence.',
    })
  }

  let feedback: Awaited<ReturnType<Dependencies['readFeedback']>>
  try {
    feedback = await deps.readFeedback({
      id: event.linkedObjectId,
      tenantId: event.tenantId,
      venueId: event.venueId,
    })
  } catch {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Visitor feedback evidence could not be read.',
    })
  }
  if (!feedback)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Current visitor feedback was not found.' })

  try {
    await deps.audit({
      tenantId: event.tenantId,
      actorId,
      actorRole: 'PLATFORM_ADMIN',
      action: 'VISITOR_FEEDBACK_HAZARD_EVIDENCE_READ',
      targetType: 'OperationalEvent',
      targetId: event.id,
      afterState: {
        venueId: event.venueId,
        feedbackId: feedback.id,
        feedbackRating: feedback.rating,
        sessionId: feedback.sessionId,
        messageId: feedback.message.id,
      },
    })
  } catch {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Visitor feedback evidence access could not be audited.',
    })
  }

  return {
    schemaVersion: 1,
    effect: 'READ_ONLY' as const,
    event: {
      id: event.id,
      tenantId: event.tenantId,
      venueId: event.venueId,
      occurrenceCount: event.occurrenceCount,
      lastOccurredAt: event.lastOccurredAt,
    },
    currentFeedback: {
      id: feedback.id,
      rating: feedback.rating,
      reason: feedback.reason,
      updatedAt: feedback.updatedAt,
      sessionId: feedback.sessionId,
      linkedMessage: feedback.message,
    },
    boundaries: {
      signalUnverified: true,
      feedbackMutable: true,
      currentFeedbackOnly: true,
      venuePublicationAuthorized: false,
      operationalMutationAuthorized: false,
    },
  }
}

export const adminVisitorFeedbackHazardEvidenceRouter = router({
  visitorFeedbackHazardEvidence: adminProcedure
    .input(visitorFeedbackHazardEvidenceInput)
    .query(({ ctx, input }) => readVisitorFeedbackHazardEvidence(input, ctx.session.userId)),
})
