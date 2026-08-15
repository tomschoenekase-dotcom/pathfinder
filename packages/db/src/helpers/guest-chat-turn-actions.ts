import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { db } from '../client'
import { lockGuestChatTurnMutation } from './venue-content-lock'

export const GUEST_CHAT_TURN_LEASE_MS = 2 * 60 * 1_000
export const GUEST_CHAT_REQUEST_HASH_VERSION = 'guest-chat-turn-request-v1'

const scopeSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    anonymousToken: z.string().uuid(),
    requestId: z.string().uuid(),
  })
  .strict()

const requestObjectSchema = scopeSchema
  .extend({
    visitorId: z.string().uuid().nullable(),
    message: z.string().trim().min(1).max(1000),
    language: z.string().trim().min(1).max(64).nullable(),
    lat: z.number().finite().min(-90).max(90).nullable(),
    lng: z.number().finite().min(-180).max(180).nullable(),
    retainLocation: z.boolean(),
  })
  .strict()

const requestSchema = requestObjectSchema.superRefine((value, ctx) => {
  if ((value.lat === null) !== (value.lng === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Coordinates must be paired.' })
  }
})

const claimSchema = scopeSchema
  .extend({ turnId: z.string().uuid(), claimId: z.string().uuid() })
  .strict()

const providerOperationSchema = claimSchema
  .extend({ kind: z.enum(['QUERY_EMBEDDING', 'RESPONSE_GENERATION']) })
  .strict()

const providerObservationSchema = providerOperationSchema
  .extend({
    outcomeCode: z.string().trim().min(1).max(64),
    usageReference: z.string().trim().min(1).max(191).nullable().optional(),
  })
  .strict()

const failureClaimSchema = claimSchema
  .extend({ failureCode: z.string().trim().min(1).max(64) })
  .strict()

const placeCardSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    name: z.string().trim().min(1).max(300),
    type: z.string().trim().min(1).max(100),
    shortDescription: z.string().trim().max(2000).nullable().optional(),
    areaName: z.string().trim().max(300).nullable().optional(),
    hours: z.string().trim().max(1000).nullable().optional(),
    photoUrl: z.string().url().max(2048).nullable().optional(),
    distanceMeters: z.number().finite().nonnegative().max(100_000).optional(),
    lat: z.number().finite().min(-90).max(90).nullable(),
    lng: z.number().finite().min(-180).max(180).nullable(),
  })
  .strict()

export const GuestChatReplayMetadata = z
  .object({ places: z.array(placeCardSchema).max(20) })
  .strict()

const finalizeSchema = requestObjectSchema
  .extend({
    turnId: z.string().uuid(),
    claimId: z.string().uuid(),
    assistantResponse: z.string().trim().min(1).max(10_000),
    replayMetadata: GuestChatReplayMetadata,
    fallbackCode: z.string().trim().min(1).max(64).nullable(),
    nextPending: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('NONE') }).strict(),
      z.object({ kind: z.literal('AUTHORED'), questionId: z.string().min(1).max(191) }).strict(),
      z.object({ kind: z.literal('INVENTED') }).strict(),
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.lat === null) !== (value.lng === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Coordinates must be paired.' })
    }
  })

export type GuestChatTurnActionClient = Pick<
  typeof db,
  '$transaction' | 'guestChatTurn' | 'guestChatProviderOperation'
>

export type GuestChatRequest = z.infer<typeof requestSchema>
export type GuestChatClaim = z.infer<typeof claimSchema>
export type GuestChatProviderOperationClaim = z.infer<typeof providerOperationSchema>
export type GuestChatFinalize = z.infer<typeof finalizeSchema>

export type GuestChatTurnActionErrorCode =
  | 'INVALID_INPUT'
  | 'CONFLICT'
  | 'IN_PROGRESS'
  | 'UNKNOWN_PROVIDER_OUTCOME'
  | 'FAILED'
  | 'NOT_FOUND'

export class GuestChatTurnActionError extends Error {
  constructor(
    readonly code: GuestChatTurnActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GuestChatTurnActionError'
  }
}

function invalidInput(): never {
  throw new GuestChatTurnActionError('INVALID_INPUT', 'Invalid guest chat turn input.')
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) invalidInput()
  return result.data
}

function isP2002(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

export function guestChatRequestHash(input: unknown): string {
  const value = parse(requestSchema, input)
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: GUEST_CHAT_REQUEST_HASH_VERSION,
        tenantId: value.tenantId,
        venueId: value.venueId,
        anonymousToken: value.anonymousToken,
        visitorId: value.visitorId,
        message: value.message,
        language: value.language,
        lat: value.lat,
        lng: value.lng,
        retainLocation: value.retainLocation,
      }),
    )
    .digest('hex')
}

const turnSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  sessionId: true,
  requestId: true,
  requestHash: true,
  turnSequence: true,
  status: true,
  leaseToken: true,
  leaseExpiresAt: true,
  userMessageId: true,
  assistantMessageId: true,
  replayMetadata: true,
  responseHash: true,
  failureCode: true,
  createdAt: true,
  pendingQuestionId: true,
  pendingIsInvented: true,
  pendingAskedMessageId: true,
  pendingAskedAt: true,
  providerOperations: {
    select: { kind: true, status: true, invocationId: true, dispatchedAt: true },
    orderBy: { kind: 'asc' as const },
  },
} as const

type GuestChatTurnState = {
  id: string
  tenantId: string
  venueId: string
  sessionId: string
  requestId: string
  requestHash: string
  turnSequence: number
  status: 'RESERVED' | 'GENERATING' | 'COMPLETE' | 'FAILED' | 'AMBIGUOUS'
  leaseToken: string | null
  leaseExpiresAt: Date | null
  userMessageId: string | null
  assistantMessageId: string | null
  replayMetadata: unknown
  responseHash: string | null
  failureCode: string | null
  createdAt: Date
  pendingQuestionId: string | null
  pendingIsInvented: boolean
  pendingAskedMessageId: string | null
  pendingAskedAt: Date | null
  providerOperations: Array<{
    kind: 'QUERY_EMBEDDING' | 'RESPONSE_GENERATION'
    status: 'RESERVED' | 'DISPATCHED' | 'OBSERVED' | 'CANCELLED' | 'TERMINAL_AMBIGUOUS'
    invocationId: string
    dispatchedAt: Date | null
  }>
}
type ReplayReader = {
  message: {
    findFirst(args: {
      where: {
        id: string
        tenantId: string
        venueId: string
        sessionId: string
        guestChatTurnId: string
      }
      select: { content: true }
    }): Promise<{ content: string } | null>
  }
}

async function projectExistingTurn(
  tx: ReplayReader,
  turn: GuestChatTurnState,
  requestHash: string,
  retry?: { allowUndispatchedReservation: boolean; now: Date },
) {
  if (turn.requestHash !== requestHash) {
    throw new GuestChatTurnActionError('CONFLICT', 'Operation identity is already bound.')
  }
  if (turn.status === 'COMPLETE') {
    const userMessageId = turn.userMessageId
    const assistantMessageId = turn.assistantMessageId
    if (!userMessageId || !assistantMessageId) {
      throw new GuestChatTurnActionError('CONFLICT', 'Terminal chat evidence is inconsistent.')
    }
    const assistant = await tx.message.findFirst({
      where: {
        id: assistantMessageId,
        tenantId: turn.tenantId,
        venueId: turn.venueId,
        sessionId: turn.sessionId,
        guestChatTurnId: turn.id,
      },
      select: { content: true },
    })
    const metadata = GuestChatReplayMetadata.safeParse(turn.replayMetadata)
    if (!assistant || !metadata.success) {
      throw new GuestChatTurnActionError('CONFLICT', 'Terminal chat evidence is inconsistent.')
    }
    const responseHash = createHash('sha256')
      .update(JSON.stringify({ response: assistant.content, places: metadata.data.places }))
      .digest('hex')
    if (responseHash !== turn.responseHash) {
      throw new GuestChatTurnActionError('CONFLICT', 'Terminal chat evidence is inconsistent.')
    }
    return {
      state: 'COMPLETE' as const,
      turnId: turn.id,
      sessionId: turn.sessionId,
      userMessageId,
      response: assistant.content,
      places: metadata.data.places,
      replayed: true,
    }
  }
  if (turn.status === 'FAILED') {
    throw new GuestChatTurnActionError('FAILED', 'The original chat turn failed before completion.')
  }
  if (turn.status === 'AMBIGUOUS' || turn.providerOperations.some((op) => op.dispatchedAt)) {
    throw new GuestChatTurnActionError(
      'UNKNOWN_PROVIDER_OUTCOME',
      'The provider outcome is unknown; this operation will not be dispatched again.',
    )
  }
  if (
    retry?.allowUndispatchedReservation &&
    (turn.status === 'RESERVED' ||
      (turn.status === 'GENERATING' &&
        turn.leaseExpiresAt !== null &&
        turn.leaseExpiresAt.getTime() <= retry.now.getTime()))
  ) {
    return {
      state: 'RESERVED' as const,
      turnId: turn.id,
      sessionId: turn.sessionId,
      replayed: true,
    }
  }
  throw new GuestChatTurnActionError('IN_PROGRESS', 'The chat turn is already in progress.')
}

export async function reserveGuestChatTurnAction(args: {
  client?: GuestChatTurnActionClient
  request: GuestChatRequest
  now?: Date
}) {
  const request = parse(requestSchema, args?.request)
  const requestHash = guestChatRequestHash(request)
  const client = args.client ?? db
  const now = args.now ?? new Date()

  const run = async (replayOnly: boolean) =>
    client.$transaction(
      async (tx) => {
        await lockGuestChatTurnMutation(tx, {
          tenantId: request.tenantId,
          lockId: `${request.venueId}:${request.anonymousToken}`,
        })
        let session = await tx.visitorSession.findFirst({
          where: {
            tenantId: request.tenantId,
            venueId: request.venueId,
            anonymousToken: request.anonymousToken,
          },
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            nextTurnSequence: true,
            nextMessageSequence: true,
            pendingEngagementQuestionId: true,
            pendingEngagementIsInvented: true,
            pendingEngagementAskedMessageId: true,
            pendingEngagementAskedAt: true,
          },
        })
        if (!session && !replayOnly) {
          session = await tx.visitorSession.create({
            data: {
              tenantId: request.tenantId,
              venueId: request.venueId,
              anonymousToken: request.anonymousToken,
              visitorId: request.visitorId,
              latestLat: request.retainLocation ? request.lat : null,
              latestLng: request.retainLocation ? request.lng : null,
            },
            select: {
              id: true,
              tenantId: true,
              venueId: true,
              nextTurnSequence: true,
              nextMessageSequence: true,
              pendingEngagementQuestionId: true,
              pendingEngagementIsInvented: true,
              pendingEngagementAskedMessageId: true,
              pendingEngagementAskedAt: true,
            },
          })
        }
        if (!session) {
          throw new GuestChatTurnActionError(
            'CONFLICT',
            'Operation identity could not be resolved.',
          )
        }

        const existing = await tx.guestChatTurn.findFirst({
          where: {
            tenantId: request.tenantId,
            sessionId: session.id,
            requestId: request.requestId,
          },
          select: turnSelect,
        })
        if (
          existing &&
          existing.requestHash === requestHash &&
          existing.status === 'GENERATING' &&
          existing.leaseExpiresAt !== null &&
          existing.leaseExpiresAt.getTime() <= now.getTime() &&
          existing.providerOperations.some((operation) => operation.dispatchedAt !== null)
        ) {
          const hasUnobservedDispatch = existing.providerOperations.some(
            (operation) => operation.status === 'DISPATCHED',
          )
          const ambiguityCode = hasUnobservedDispatch
            ? 'LEASE_EXPIRED_AFTER_DISPATCH'
            : 'LEASE_EXPIRED_AFTER_OBSERVED_RESULTS'
          const ambiguous = await tx.guestChatProviderOperation.updateMany({
            where: {
              tenantId: request.tenantId,
              venueId: request.venueId,
              sessionId: session.id,
              turnId: existing.id,
              status: 'DISPATCHED',
              observedAt: null,
            },
            data: {
              status: 'TERMINAL_AMBIGUOUS',
              outcomeCode: ambiguityCode,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          })
          if (hasUnobservedDispatch && ambiguous.count < 1)
            throw new GuestChatTurnActionError(
              'CONFLICT',
              'Provider reconciliation evidence changed.',
            )
          await tx.guestChatProviderOperation.updateMany({
            where: {
              tenantId: request.tenantId,
              venueId: request.venueId,
              sessionId: session.id,
              turnId: existing.id,
              status: 'RESERVED',
            },
            data: {
              status: 'CANCELLED',
              outcomeCode: 'TURN_TERMINAL_AMBIGUOUS',
              leaseToken: null,
              leaseExpiresAt: null,
            },
          })
          const restored = await tx.visitorSession.updateMany({
            where: {
              id: session.id,
              tenantId: request.tenantId,
              venueId: request.venueId,
              pendingEngagementQuestionId: null,
              pendingEngagementIsInvented: false,
              pendingEngagementAskedMessageId: null,
              pendingEngagementAskedAt: null,
            },
            data: {
              pendingEngagementQuestionId: existing.pendingQuestionId,
              pendingEngagementIsInvented: existing.pendingIsInvented,
              pendingEngagementAskedMessageId: existing.pendingAskedMessageId,
              pendingEngagementAskedAt: existing.pendingAskedAt,
            },
          })
          if (restored.count !== 1) {
            throw new GuestChatTurnActionError('CONFLICT', 'Session pending state changed.')
          }
          const terminal = await tx.guestChatTurn.updateMany({
            where: {
              id: existing.id,
              tenantId: request.tenantId,
              venueId: request.venueId,
              status: 'GENERATING',
              leaseToken: existing.leaseToken,
            },
            data: {
              status: 'AMBIGUOUS',
              failureCode: ambiguityCode,
              failedAt: now,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          })
          if (terminal.count !== 1) {
            throw new GuestChatTurnActionError(
              'CONFLICT',
              'Chat turn changed during reconciliation.',
            )
          }
          return {
            state: 'AMBIGUOUS' as const,
            turnId: existing.id,
            sessionId: existing.sessionId,
            replayed: true,
          }
        }
        if (existing)
          return projectExistingTurn(tx as unknown as ReplayReader, existing, requestHash, {
            allowUndispatchedReservation: true,
            now,
          })
        if (replayOnly) {
          throw new GuestChatTurnActionError(
            'CONFLICT',
            'Operation identity could not be resolved.',
          )
        }

        const active = await tx.guestChatTurn.findFirst({
          where: {
            tenantId: request.tenantId,
            sessionId: session.id,
            status: { in: ['RESERVED', 'GENERATING'] },
          },
          select: turnSelect,
        })
        if (active) {
          const reservedExpired =
            active.status === 'RESERVED' &&
            active.createdAt.getTime() + GUEST_CHAT_TURN_LEASE_MS <= now.getTime()
          const generatingExpired =
            active.status === 'GENERATING' &&
            active.leaseExpiresAt !== null &&
            active.leaseExpiresAt.getTime() <= now.getTime()
          if (!reservedExpired && !generatingExpired) {
            throw new GuestChatTurnActionError(
              'IN_PROGRESS',
              'Another chat turn is already in progress.',
            )
          }
          const hasUnobservedDispatch = active.providerOperations.some(
            (operation) => operation.status === 'DISPATCHED',
          )
          const hasObservedGeneration = active.providerOperations.some(
            (operation) =>
              operation.kind === 'RESPONSE_GENERATION' && operation.status === 'OBSERVED',
          )
          const isAmbiguous = hasUnobservedDispatch || hasObservedGeneration
          const ambiguityCode = hasUnobservedDispatch
            ? 'LEASE_EXPIRED_AFTER_DISPATCH'
            : 'LEASE_EXPIRED_AFTER_OBSERVED_RESULTS'
          if (isAmbiguous) {
            await tx.guestChatProviderOperation.updateMany({
              where: {
                tenantId: request.tenantId,
                venueId: request.venueId,
                sessionId: session.id,
                turnId: active.id,
                status: 'DISPATCHED',
              },
              data: {
                status: 'TERMINAL_AMBIGUOUS',
                outcomeCode: ambiguityCode,
                leaseToken: null,
                leaseExpiresAt: null,
              },
            })
          }
          await tx.guestChatProviderOperation.updateMany({
            where: {
              tenantId: request.tenantId,
              venueId: request.venueId,
              sessionId: session.id,
              turnId: active.id,
              status: 'RESERVED',
            },
            data: {
              status: 'CANCELLED',
              outcomeCode: isAmbiguous ? 'TURN_TERMINAL_AMBIGUOUS' : 'ORPHAN_EXPIRED',
              leaseToken: null,
              leaseExpiresAt: null,
            },
          })
          const restored = await tx.visitorSession.updateMany({
            where: {
              id: session.id,
              tenantId: request.tenantId,
              venueId: request.venueId,
              pendingEngagementQuestionId: null,
              pendingEngagementIsInvented: false,
              pendingEngagementAskedMessageId: null,
              pendingEngagementAskedAt: null,
            },
            data: {
              pendingEngagementQuestionId: active.pendingQuestionId,
              pendingEngagementIsInvented: active.pendingIsInvented,
              pendingEngagementAskedMessageId: active.pendingAskedMessageId,
              pendingEngagementAskedAt: active.pendingAskedAt,
            },
          })
          if (restored.count !== 1)
            throw new GuestChatTurnActionError('CONFLICT', 'Session pending state changed.')
          const terminal = await tx.guestChatTurn.updateMany({
            where: {
              id: active.id,
              tenantId: request.tenantId,
              venueId: request.venueId,
              status: active.status,
              leaseToken: active.leaseToken,
            },
            data: {
              status: isAmbiguous ? 'AMBIGUOUS' : 'FAILED',
              failureCode: isAmbiguous ? ambiguityCode : 'ORPHAN_EXPIRED',
              failedAt: now,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          })
          if (terminal.count !== 1)
            throw new GuestChatTurnActionError('CONFLICT', 'Active chat turn changed.')
          session = {
            ...session,
            pendingEngagementQuestionId: active.pendingQuestionId,
            pendingEngagementIsInvented: active.pendingIsInvented,
            pendingEngagementAskedMessageId: active.pendingAskedMessageId,
            pendingEngagementAskedAt: active.pendingAskedAt,
          }
        }

        const turnSequence = session.nextTurnSequence + 1
        const userMessageSequence = session.nextMessageSequence + 1
        const assistantMessageSequence = userMessageSequence + 1
        const advanced = await tx.visitorSession.updateMany({
          where: {
            id: session.id,
            tenantId: request.tenantId,
            venueId: request.venueId,
            nextTurnSequence: session.nextTurnSequence,
            nextMessageSequence: session.nextMessageSequence,
          },
          data: {
            ...(request.visitorId === null ? {} : { visitorId: request.visitorId }),
            latestLat: request.retainLocation ? request.lat : null,
            latestLng: request.retainLocation ? request.lng : null,
            nextTurnSequence: turnSequence,
            nextMessageSequence: assistantMessageSequence,
            pendingEngagementQuestionId: null,
            pendingEngagementIsInvented: false,
            pendingEngagementAskedMessageId: null,
            pendingEngagementAskedAt: null,
            lastActiveAt: now,
          },
        })
        if (advanced.count !== 1) {
          throw new GuestChatTurnActionError('CONFLICT', 'Session state changed concurrently.')
        }

        const turn = await tx.guestChatTurn.create({
          data: {
            tenantId: request.tenantId,
            venueId: request.venueId,
            sessionId: session.id,
            requestId: request.requestId,
            requestHash,
            turnSequence,
            userMessageSequence,
            assistantMessageSequence,
            pendingQuestionId: session.pendingEngagementQuestionId,
            pendingIsInvented: session.pendingEngagementIsInvented,
            pendingAskedMessageId: session.pendingEngagementAskedMessageId,
            pendingAskedAt: session.pendingEngagementAskedAt,
            providerOperations: {
              create: [
                {
                  kind: 'QUERY_EMBEDDING',
                  invocationId: randomUUID(),
                },
                {
                  kind: 'RESPONSE_GENERATION',
                  invocationId: randomUUID(),
                },
              ],
            },
          },
          select: turnSelect,
        })
        return {
          state: 'RESERVED' as const,
          turnId: turn.id,
          sessionId: turn.sessionId,
          replayed: false,
        }
      },
      { isolationLevel: 'Serializable' },
    )

  try {
    return await run(false)
  } catch (error) {
    if (!isP2002(error)) throw error
    return run(true)
  }
}

export async function claimGuestChatTurnAction(args: {
  client?: GuestChatTurnActionClient
  claim: GuestChatClaim
  now?: Date
}) {
  const claim = parse(claimSchema, args?.claim)
  const client = args.client ?? db
  const now = args.now ?? new Date()
  const leaseExpiresAt = new Date(now.getTime() + GUEST_CHAT_TURN_LEASE_MS)
  return client.$transaction(async (tx) => {
    const turn = await tx.guestChatTurn.findFirst({
      where: {
        id: claim.turnId,
        tenantId: claim.tenantId,
        venueId: claim.venueId,
        requestId: claim.requestId,
        session: { anonymousToken: claim.anonymousToken },
      },
      select: turnSelect,
    })
    if (!turn) throw new GuestChatTurnActionError('NOT_FOUND', 'Chat turn not found.')
    if (turn.status === 'COMPLETE')
      return projectExistingTurn(tx as unknown as ReplayReader, turn, turn.requestHash)
    if (turn.status === 'FAILED') throw new GuestChatTurnActionError('FAILED', 'Chat turn failed.')
    const dispatched = turn.providerOperations.some((op) => op.dispatchedAt !== null)
    if (dispatched || turn.status === 'AMBIGUOUS') {
      throw new GuestChatTurnActionError(
        'UNKNOWN_PROVIDER_OUTCOME',
        'Provider dispatch cannot be repeated.',
      )
    }
    const receiptKinds = new Set(
      turn.providerOperations
        .filter((operation) => operation.status === 'RESERVED')
        .map((operation) => operation.kind),
    )
    if (
      turn.providerOperations.length !== 2 ||
      receiptKinds.size !== 2 ||
      !receiptKinds.has('QUERY_EMBEDDING') ||
      !receiptKinds.has('RESPONSE_GENERATION')
    ) {
      throw new GuestChatTurnActionError(
        'CONFLICT',
        'Chat turn provider reservations are incomplete.',
      )
    }
    const sameClaim = turn.leaseToken === claim.claimId
    const expired = turn.leaseExpiresAt !== null && turn.leaseExpiresAt.getTime() <= now.getTime()
    if (turn.status === 'GENERATING' && !sameClaim && !expired) {
      throw new GuestChatTurnActionError('IN_PROGRESS', 'Chat turn generation is in progress.')
    }
    const updated = await tx.guestChatTurn.updateMany({
      where: {
        id: turn.id,
        tenantId: claim.tenantId,
        venueId: claim.venueId,
        status: turn.status,
        leaseToken: turn.leaseToken,
      },
      data: {
        status: 'GENERATING',
        leaseToken: claim.claimId,
        leaseExpiresAt,
        ...(!sameClaim ? { claimedAt: now } : {}),
      },
    })
    if (updated.count !== 1)
      throw new GuestChatTurnActionError('IN_PROGRESS', 'Chat turn claim changed.')
    const claimedOperations = await tx.guestChatProviderOperation.updateMany({
      where: {
        tenantId: claim.tenantId,
        venueId: claim.venueId,
        sessionId: turn.sessionId,
        turnId: turn.id,
        status: 'RESERVED',
        dispatchedAt: null,
      },
      data: { leaseToken: claim.claimId, leaseExpiresAt },
    })
    if (claimedOperations.count !== turn.providerOperations.length) {
      throw new GuestChatTurnActionError(
        'UNKNOWN_PROVIDER_OUTCOME',
        'Provider reservation evidence changed during claim.',
      )
    }
    return {
      state: 'GENERATING' as const,
      turnId: turn.id,
      sessionId: turn.sessionId,
      claimId: claim.claimId,
      providerOperations: turn.providerOperations.map((op) => ({
        kind: op.kind,
        invocationId: op.invocationId,
      })),
      replayed: sameClaim,
    }
  })
}

export async function markGuestChatProviderDispatchedAction(args: {
  client?: GuestChatTurnActionClient
  operation: GuestChatProviderOperationClaim
  now?: Date
}) {
  const operation = parse(providerOperationSchema, args?.operation)
  const client = args.client ?? db
  const now = args.now ?? new Date()
  return client.$transaction(async (tx) => {
    const turn = await tx.guestChatTurn.findFirst({
      where: {
        id: operation.turnId,
        tenantId: operation.tenantId,
        venueId: operation.venueId,
        requestId: operation.requestId,
        leaseToken: operation.claimId,
        status: 'GENERATING',
        session: { anonymousToken: operation.anonymousToken },
      },
      select: { sessionId: true, leaseExpiresAt: true },
    })
    if (!turn) throw new GuestChatTurnActionError('CONFLICT', 'Chat turn claim is no longer valid.')
    if (!turn.leaseExpiresAt || turn.leaseExpiresAt.getTime() <= now.getTime()) {
      throw new GuestChatTurnActionError('IN_PROGRESS', 'Chat turn claim expired before dispatch.')
    }
    const updated = await tx.guestChatProviderOperation.updateMany({
      where: {
        tenantId: operation.tenantId,
        venueId: operation.venueId,
        sessionId: turn.sessionId,
        turnId: operation.turnId,
        kind: operation.kind,
        status: 'RESERVED',
        dispatchedAt: null,
        leaseToken: operation.claimId,
        leaseExpiresAt: { gt: now },
      },
      data: { status: 'DISPATCHED', dispatchedAt: now, leaseToken: null, leaseExpiresAt: null },
    })
    if (updated.count !== 1) {
      throw new GuestChatTurnActionError(
        'UNKNOWN_PROVIDER_OUTCOME',
        'Provider operation was already dispatched.',
      )
    }
    return { dispatched: true as const }
  })
}

export async function observeGuestChatProviderOperationAction(args: {
  client?: GuestChatTurnActionClient
  operation: GuestChatProviderOperationClaim & {
    outcomeCode: string
    usageReference?: string | null
  }
  now?: Date
}) {
  const operation = parse(providerObservationSchema, args?.operation)
  const client = args.client ?? db
  const now = args.now ?? new Date()
  const updated = await client.guestChatProviderOperation.updateMany({
    where: {
      tenantId: operation.tenantId,
      venueId: operation.venueId,
      turnId: operation.turnId,
      kind: operation.kind,
      status: 'DISPATCHED',
      turn: {
        requestId: operation.requestId,
        leaseToken: operation.claimId,
        session: { anonymousToken: operation.anonymousToken },
      },
    },
    data: {
      status: 'OBSERVED',
      observedAt: now,
      outcomeCode: operation.outcomeCode,
      usageReference: operation.usageReference ?? null,
    },
  })
  if (updated.count !== 1)
    throw new GuestChatTurnActionError('CONFLICT', 'Provider observation did not match.')
  return { observed: true as const }
}

export async function failGuestChatTurnAction(args: {
  client?: GuestChatTurnActionClient
  claim: GuestChatClaim & { failureCode: string }
  now?: Date
}) {
  const claim = parse(failureClaimSchema, args?.claim)
  const client = args.client ?? db
  const now = args.now ?? new Date()
  return client.$transaction(async (tx) => {
    await lockGuestChatTurnMutation(tx, { tenantId: claim.tenantId, lockId: claim.turnId })
    const turn = await tx.guestChatTurn.findFirst({
      where: {
        id: claim.turnId,
        tenantId: claim.tenantId,
        venueId: claim.venueId,
        requestId: claim.requestId,
        leaseToken: claim.claimId,
        status: 'GENERATING',
        session: { anonymousToken: claim.anonymousToken },
      },
      select: {
        sessionId: true,
        pendingQuestionId: true,
        pendingIsInvented: true,
        pendingAskedMessageId: true,
        pendingAskedAt: true,
        providerOperations: {
          select: { id: true, status: true },
        },
      },
    })
    if (!turn) throw new GuestChatTurnActionError('CONFLICT', 'Chat turn failure did not match.')
    if (
      turn.providerOperations.some(
        (operation) =>
          operation.status === 'DISPATCHED' || operation.status === 'TERMINAL_AMBIGUOUS',
      )
    ) {
      throw new GuestChatTurnActionError(
        'UNKNOWN_PROVIDER_OUTCOME',
        'An unobserved provider operation cannot be failed as pre-dispatch.',
      )
    }
    const restored = await tx.visitorSession.updateMany({
      where: {
        id: turn.sessionId,
        tenantId: claim.tenantId,
        venueId: claim.venueId,
        pendingEngagementQuestionId: null,
        pendingEngagementIsInvented: false,
        pendingEngagementAskedMessageId: null,
        pendingEngagementAskedAt: null,
      },
      data: {
        pendingEngagementQuestionId: turn.pendingQuestionId,
        pendingEngagementIsInvented: turn.pendingIsInvented,
        pendingEngagementAskedMessageId: turn.pendingAskedMessageId,
        pendingEngagementAskedAt: turn.pendingAskedAt,
      },
    })
    if (restored.count !== 1)
      throw new GuestChatTurnActionError('CONFLICT', 'Session pending state changed.')
    const reservedOperationCount = turn.providerOperations.filter(
      (operation) => operation.status === 'RESERVED',
    ).length
    const cancelled = await tx.guestChatProviderOperation.updateMany({
      where: {
        tenantId: claim.tenantId,
        venueId: claim.venueId,
        sessionId: turn.sessionId,
        turnId: claim.turnId,
        status: 'RESERVED',
      },
      data: {
        status: 'CANCELLED',
        outcomeCode: claim.failureCode,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    })
    if (cancelled.count !== reservedOperationCount) {
      throw new GuestChatTurnActionError('CONFLICT', 'Provider failure evidence changed.')
    }
    const updated = await tx.guestChatTurn.updateMany({
      where: {
        id: claim.turnId,
        tenantId: claim.tenantId,
        venueId: claim.venueId,
        status: 'GENERATING',
        leaseToken: claim.claimId,
      },
      data: {
        status: 'FAILED',
        failureCode: claim.failureCode,
        failedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    })
    if (updated.count !== 1)
      throw new GuestChatTurnActionError('CONFLICT', 'Chat turn failure did not match.')
    return { failed: true as const }
  })
}

export async function finalizeGuestChatTurnAction(args: {
  client?: GuestChatTurnActionClient
  input: GuestChatFinalize
  now?: Date
}) {
  const input = parse(finalizeSchema, args?.input)
  const client = args.client ?? db
  const now = args.now ?? new Date()
  const replayMetadata = JSON.parse(JSON.stringify(input.replayMetadata)) as z.infer<
    typeof GuestChatReplayMetadata
  >
  const responseHash = createHash('sha256')
    .update(JSON.stringify({ response: input.assistantResponse, places: replayMetadata.places }))
    .digest('hex')

  const run = () =>
    client.$transaction(
      async (tx) => {
        await lockGuestChatTurnMutation(tx, { tenantId: input.tenantId, lockId: input.turnId })
        const turn = await tx.guestChatTurn.findFirst({
          where: {
            id: input.turnId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            requestId: input.requestId,
            session: { anonymousToken: input.anonymousToken },
          },
          select: { ...turnSelect, userMessageSequence: true, assistantMessageSequence: true },
        })
        if (!turn) throw new GuestChatTurnActionError('NOT_FOUND', 'Chat turn not found.')
        if (turn.requestHash !== guestChatRequestHash(input)) {
          throw new GuestChatTurnActionError(
            'CONFLICT',
            'Finalization request does not match reservation.',
          )
        }
        if (turn.status === 'COMPLETE')
          return projectExistingTurn(tx as unknown as ReplayReader, turn, turn.requestHash)
        if (turn.status !== 'GENERATING')
          throw new GuestChatTurnActionError('CONFLICT', 'Chat turn is not finalizable.')
        if (turn.leaseToken !== input.claimId) {
          throw new GuestChatTurnActionError('CONFLICT', 'Chat turn claim is no longer valid.')
        }
        const operations = new Map(turn.providerOperations.map((op) => [op.kind, op.status]))
        if (
          operations.get('QUERY_EMBEDDING') !== 'OBSERVED' ||
          operations.get('RESPONSE_GENERATION') !== 'OBSERVED'
        ) {
          throw new GuestChatTurnActionError(
            'UNKNOWN_PROVIDER_OUTCOME',
            'Provider evidence is incomplete.',
          )
        }

        const userMessageId = randomUUID()
        const assistantMessageId = randomUUID()
        await tx.message.createMany({
          data: [
            {
              id: userMessageId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              sessionId: turn.sessionId,
              guestChatTurnId: turn.id,
              sessionSequence: turn.userMessageSequence,
              turnMessageSequence: 0,
              role: 'user',
              content: input.message,
              createdAt: now,
            },
            {
              id: assistantMessageId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              sessionId: turn.sessionId,
              guestChatTurnId: turn.id,
              sessionSequence: turn.assistantMessageSequence,
              turnMessageSequence: 1,
              role: 'assistant',
              content: input.assistantResponse,
              createdAt: now,
            },
          ],
        })

        if (turn.pendingAskedMessageId) {
          const question = turn.pendingQuestionId
            ? await tx.engagementQuestion.findFirst({
                where: { id: turn.pendingQuestionId, tenantId: input.tenantId },
                select: { prompt: true, questionType: true },
              })
            : await tx.message.findFirst({
                where: {
                  id: turn.pendingAskedMessageId,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  sessionId: turn.sessionId,
                },
                select: { content: true },
              })
          if (!question)
            throw new GuestChatTurnActionError(
              'CONFLICT',
              'Reserved engagement evidence is missing.',
            )
          await tx.engagementQuestionResponse.create({
            data: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              sessionId: turn.sessionId,
              guestChatTurnId: turn.id,
              engagementQuestionId: turn.pendingQuestionId,
              isAiInvented: turn.pendingIsInvented,
              answerType: 'questionType' in question ? question.questionType : 'OPEN_ENDED',
              questionText: 'prompt' in question ? question.prompt : question.content,
              askedMessageId: turn.pendingAskedMessageId,
              answerMessageId: userMessageId,
              answerText: input.message,
              askedAt: turn.pendingAskedAt ?? now,
              answeredAt: now,
            },
          })
        }

        if (input.nextPending.kind === 'AUTHORED') {
          const exists = await tx.engagementQuestion.findFirst({
            where: { id: input.nextPending.questionId, tenantId: input.tenantId, isActive: true },
            select: { id: true },
          })
          if (!exists)
            throw new GuestChatTurnActionError('CONFLICT', 'Engagement question is unavailable.')
        }
        const sessionUpdated = await tx.visitorSession.updateMany({
          where: {
            id: turn.sessionId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            pendingEngagementQuestionId: null,
            pendingEngagementIsInvented: false,
            pendingEngagementAskedMessageId: null,
            pendingEngagementAskedAt: null,
          },
          data: {
            messageCount: { increment: 2 },
            lastActiveAt: now,
            pendingEngagementQuestionId:
              input.nextPending.kind === 'AUTHORED' ? input.nextPending.questionId : null,
            pendingEngagementIsInvented: input.nextPending.kind === 'INVENTED',
            pendingEngagementAskedMessageId:
              input.nextPending.kind === 'NONE' ? null : assistantMessageId,
            pendingEngagementAskedAt: input.nextPending.kind === 'NONE' ? null : now,
          },
        })
        if (sessionUpdated.count !== 1) {
          throw new GuestChatTurnActionError(
            'CONFLICT',
            'Session pending state changed during finalization.',
          )
        }

        const terminal = await tx.guestChatTurn.updateMany({
          where: {
            id: turn.id,
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: 'GENERATING',
            leaseToken: input.claimId,
          },
          data: {
            status: 'COMPLETE',
            userMessageId,
            assistantMessageId,
            replayMetadata,
            responseHash,
            fallbackCode: input.fallbackCode,
            completedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        })
        if (terminal.count !== 1)
          throw new GuestChatTurnActionError('CONFLICT', 'Chat turn changed during finalization.')
        return {
          state: 'COMPLETE' as const,
          turnId: turn.id,
          sessionId: turn.sessionId,
          userMessageId,
          response: input.assistantResponse,
          places: replayMetadata.places,
          replayed: false,
        }
      },
      { isolationLevel: 'Serializable' },
    )

  try {
    return await run()
  } catch (error) {
    if (!isP2002(error)) throw error
    return run()
  }
}
