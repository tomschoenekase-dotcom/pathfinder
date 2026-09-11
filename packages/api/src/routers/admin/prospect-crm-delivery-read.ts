import { TRPCError } from '@trpc/server'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

export async function readProspectOnboardingDeliveryAttempt(input: {
  organizationId: string
  prospectVenueId: string
  messageId: string
}) {
  return withTenantIsolationBypass(async () => {
    const attempt = await db.prospectOnboardingDeliveryAttempt.findFirst({
      where: {
        organizationId: input.organizationId,
        prospectVenueId: input.prospectVenueId,
        sourceMessageId: input.messageId,
        sourceMessage: {
          organizationId: input.organizationId,
          venueId: input.prospectVenueId,
        },
      },
      select: {
        id: true,
        status: true,
        organizationId: true,
        prospectVenueId: true,
        contactId: true,
        sourceMessageId: true,
        sourceReviewId: true,
        recipientEmailSnapshot: true,
        templateVersion: true,
        subject: true,
        textBody: true,
        createdBy: true,
        createdAt: true,
        sourceMessage: {
          select: { inboundReplyDisposition: true, inboundReplyReviewId: true },
        },
      },
    })
    if (!attempt) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Invitation draft not found' })
    }
    const { sourceMessage, ...draft } = attempt
    // The immutable draft records its original review. A later classification
    // must remain visible without rewriting that historical invitation.
    return {
      ...draft,
      currentReview: {
        id: sourceMessage.inboundReplyReviewId,
        disposition: sourceMessage.inboundReplyDisposition,
        state:
          sourceMessage.inboundReplyReviewId &&
          sourceMessage.inboundReplyDisposition === 'POSITIVE_INTEREST'
            ? ('POSITIVE_INTEREST' as const)
            : ('HELD' as const),
      },
      deliveryAuthorization: 'NOT_GRANTED_BY_DRAFT' as const,
    }
  })
}

export async function listProspectActivities(input: {
  organizationId: string
  limit: number
  beforeOccurredAt?: string | undefined
  beforeId?: string | undefined
}) {
  return withTenantIsolationBypass(async () => {
    if (Boolean(input.beforeOccurredAt) !== Boolean(input.beforeId)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Both activity cursor fields are required',
      })
    }

    const occurredAt = input.beforeOccurredAt ? new Date(input.beforeOccurredAt) : null
    const rows = await db.prospectActivity.findMany({
      where: {
        organizationId: input.organizationId,
        ...(occurredAt && input.beforeId
          ? {
              OR: [{ occurredAt: { lt: occurredAt } }, { occurredAt, id: { lt: input.beforeId } }],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    })
    const last = rows[input.limit - 1]
    return {
      items: rows.slice(0, input.limit),
      nextCursor:
        rows.length > input.limit && last
          ? { beforeOccurredAt: last.occurredAt.toISOString(), beforeId: last.id }
          : null,
    }
  })
}
