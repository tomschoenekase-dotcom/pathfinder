import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass, writeAuditLogStrict } from '@pathfinder/db'

export const guestChatIncidentEvidenceInput = z.object({ eventId: z.string().uuid() }).strict()

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
  readTurn(input: { id: string; tenantId: string; venueId: string }): Promise<{
    id: string
    status: string
    fallbackCode: string | null
    completedAt: Date | null
    providerOperations: Array<{
      kind: string
      status: string
      outcomeCode: string | null
      usageReference: string | null
      dispatchedAt: Date | null
      observedAt: Date | null
    }>
  } | null>
  readUsage(input: { ids: string[]; tenantId: string; venueId: string }): Promise<
    Array<{
      id: string
      capability: string
      routeModelKey: string | null
      fallbackUsed: boolean
      provider: string
      model: string
      latencyMs: number
      attempts: number
      success: boolean
      errorCode: string | null
      createdAt: Date
    }>
  >
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
  readTurn: ({ id, tenantId, venueId }) =>
    withTenantIsolationBypass(() =>
      db.guestChatTurn.findFirst({
        where: { id, tenantId, venueId },
        select: {
          id: true,
          status: true,
          fallbackCode: true,
          completedAt: true,
          providerOperations: {
            orderBy: { kind: 'asc' },
            select: {
              kind: true,
              status: true,
              outcomeCode: true,
              usageReference: true,
              dispatchedAt: true,
              observedAt: true,
            },
          },
        },
      }),
    ),
  readUsage: ({ ids, tenantId, venueId }) =>
    withTenantIsolationBypass(() =>
      db.aiUsageEvent.findMany({
        where: { id: { in: ids }, tenantId, venueId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          capability: true,
          routeModelKey: true,
          fallbackUsed: true,
          provider: true,
          model: true,
          latencyMs: true,
          attempts: true,
          success: true,
          errorCode: true,
          createdAt: true,
        },
      }),
    ),
  audit: writeAuditLogStrict,
}

export async function readGuestChatIncidentEvidence(
  input: z.infer<typeof guestChatIncidentEvidenceInput>,
  actorId: string,
  deps: Dependencies = dependencies,
) {
  let event: Awaited<ReturnType<Dependencies['readEvent']>>
  try {
    event = await deps.readEvent(input.eventId)
  } catch {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Incident evidence could not be read.',
    })
  }
  if (!event)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Operational event was not found.' })
  if (
    event.eventType !== 'guest-chat.route-degraded' ||
    event.linkedObjectType !== 'guest-chat-turn' ||
    !event.linkedObjectId ||
    !event.venueId
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This alert does not contain exact guest-chat turn evidence.',
    })
  }

  let turn: Awaited<ReturnType<Dependencies['readTurn']>>
  try {
    turn = await deps.readTurn({
      id: event.linkedObjectId,
      tenantId: event.tenantId,
      venueId: event.venueId,
    })
  } catch {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Guest-chat turn evidence could not be read.',
    })
  }
  if (!turn)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Guest-chat turn evidence was not found.' })

  const usageIds = turn.providerOperations.flatMap((operation) =>
    operation.usageReference ? [operation.usageReference] : [],
  )
  let usage: Awaited<ReturnType<Dependencies['readUsage']>>
  try {
    usage = usageIds.length
      ? await deps.readUsage({ ids: usageIds, tenantId: event.tenantId, venueId: event.venueId })
      : []
  } catch {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Sanitized AI usage evidence could not be read.',
    })
  }

  try {
    await deps.audit({
      tenantId: event.tenantId,
      actorId,
      actorRole: 'PLATFORM_ADMIN',
      action: 'GUEST_CHAT_INCIDENT_EVIDENCE_READ',
      targetType: 'OperationalEvent',
      targetId: event.id,
      afterState: {
        venueId: event.venueId,
        turnId: turn.id,
        providerOperationCount: turn.providerOperations.length,
        usageEvidenceCount: usage.length,
      },
    })
  } catch {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Incident evidence access could not be audited.',
    })
  }

  const usageById = new Map(usage.map((row) => [row.id, row]))
  return {
    schemaVersion: 1,
    effect: 'READ_ONLY' as const,
    event: {
      id: event.id,
      tenantId: event.tenantId,
      venueId: event.venueId,
      occurrenceCount: event.occurrenceCount,
      lastOccurredAt: event.lastOccurredAt,
      latestTurn: {
        id: turn.id,
        status: turn.status,
        fallbackCode: turn.fallbackCode,
        completedAt: turn.completedAt,
        providerOperations: turn.providerOperations.map(({ usageReference, ...operation }) => ({
          ...operation,
          usage: usageReference ? (usageById.get(usageReference) ?? null) : null,
        })),
      },
    },
    boundaries: {
      latestOccurrenceOnly: true,
      transcriptIncluded: false,
      promptIncluded: false,
      responseIncluded: false,
      providerExceptionIncluded: false,
      providerControlAuthorized: false,
      retryAuthorized: false,
      incidentMutationAuthorized: false,
    },
  }
}
