import { createHash } from 'node:crypto'

import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type Client = Pick<typeof db, '$transaction'>
type Transaction = Parameters<Parameters<Client['$transaction']>[0]>[0]

const scopedId = z.string().trim().min(1).max(191)
const actor = z
  .object({
    userId: scopedId,
    auditRole: z.enum(['STAFF', 'MANAGER', 'OWNER', 'PLATFORM_ADMIN']),
  })
  .strict()

const preferenceInput = z
  .object({
    tenantId: scopedId,
    enabled: z.boolean(),
    minimized: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
    actor,
  })
  .strict()

const reserveTurnInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: scopedId,
    venueId: scopedId,
    behaviorVersion: z.string().trim().min(1).max(100),
    userMessage: z.string().trim().min(1).max(2_000),
    actor,
  })
  .strict()

export const ClientAssistantFailureCode = z.literal('assistant-unavailable')
export type ClientAssistantFailureCode = z.infer<typeof ClientAssistantFailureCode>

const completeTurnInput = z
  .object({
    tenantId: scopedId,
    venueId: scopedId,
    turnId: scopedId,
    generationLeaseId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    assistantMessage: z.string().trim().min(1).max(1_200),
    questionCategory: z.string().trim().min(1).max(100),
    safeActions: z.array(z.record(z.unknown())).max(3),
    outcome: z.discriminatedUnion('status', [
      z.object({ status: z.literal('COMPLETED') }).strict(),
      z
        .object({
          status: z.literal('FAILED'),
          failureCode: ClientAssistantFailureCode,
        })
        .strict(),
    ]),
    actor,
  })
  .strict()

const claimTurnInput = z
  .object({
    tenantId: scopedId,
    venueId: scopedId,
    turnId: scopedId,
    generationLeaseId: z.string().uuid(),
    leaseDurationMs: z.number().int().min(5_000).max(120_000).default(30_000),
    now: z.date().optional(),
    actor,
  })
  .strict()

const markDispatchedInput = z
  .object({
    tenantId: scopedId,
    venueId: scopedId,
    turnId: scopedId,
    generationLeaseId: z.string().uuid(),
    dispatchedAt: z.date().optional(),
    actor,
  })
  .strict()

const handoffInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: scopedId,
    venueId: scopedId,
    turnId: scopedId,
    supportRequestId: scopedId,
    summarySnapshot: z
      .object({
        schemaVersion: z.literal(1),
        source: z.literal('CLIENT_TOCHI'),
        category: z.enum([
          'CONTENT_CORRECTION',
          'OPERATIONAL_UPDATE',
          'BRANDING',
          'EXPERIENCE_BEHAVIOR',
          'ACCESSIBILITY',
          'GENERAL',
        ]),
        summary: z.string().trim().min(1).max(200),
        requestedOutcome: z.string().trim().min(1).max(1_000),
        relevantFeature: z.string().trim().min(1).max(100).optional(),
        excerpt: z
          .array(
            z
              .object({
                role: z.enum(['user', 'assistant']),
                content: z.string().trim().min(1).max(300),
              })
              .strict(),
          )
          .max(4),
      })
      .strict(),
    actor,
  })
  .strict()

export type SetClientAssistantPreferenceInput = z.input<typeof preferenceInput>
export type ReserveClientAssistantTurnInput = z.input<typeof reserveTurnInput>
export type CompleteClientAssistantTurnInput = z.input<typeof completeTurnInput>
export type ClaimClientAssistantTurnInput = z.input<typeof claimTurnInput>
export type MarkClientAssistantTurnDispatchedInput = z.input<typeof markDispatchedInput>
export type LinkClientAssistantHandoffInput = z.input<typeof handoffInput>

export class ClientAssistantActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'ClientAssistantActionError'
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success)
    throw new ClientAssistantActionError('INVALID_INPUT', 'Client assistant input is invalid')
  return result.data
}

async function requireActiveMembership(tx: Transaction, tenantId: string, userId: string) {
  const membership = await tx.tenantMembership.findFirst({
    where: { tenantId, userId, status: 'ACTIVE' },
    select: { id: true },
  })
  if (!membership)
    throw new ClientAssistantActionError('NOT_FOUND', 'Client assistant is not available')
}

async function lockClientAssistantGeneration(tx: Transaction, tenantId: string, turnId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`torchiko:client-assistant-claim:${tenantId}:${turnId}`}, 0))`
}

export async function setClientAssistantPreferenceAction(
  rawInput: SetClientAssistantPreferenceInput,
  client: Client = db,
) {
  const input = parse(preferenceInput, rawInput)
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`torchiko:client-assistant-preference:${input.tenantId}:${input.actor.userId}`}, 0))`
    await requireActiveMembership(tx, input.tenantId, input.actor.userId)
    const existing = await tx.clientAssistantPreference.findUnique({
      where: {
        tenantId_userId: { tenantId: input.tenantId, userId: input.actor.userId },
      },
      select: { id: true, enabled: true, minimized: true, revision: true, updatedAt: true },
    })
    if ((existing?.revision ?? 0) !== input.expectedRevision)
      throw new ClientAssistantActionError('CONFLICT', 'Tochi preference changed; refresh it')

    const preference = existing
      ? await tx.clientAssistantPreference.update({
          where: { id: existing.id },
          data: {
            enabled: input.enabled,
            minimized: input.minimized,
            updatedBy: input.actor.userId,
            revision: { increment: 1 },
          },
          select: {
            enabled: true,
            minimized: true,
            revision: true,
            updatedAt: true,
          },
        })
      : await tx.clientAssistantPreference.create({
          data: {
            tenantId: input.tenantId,
            userId: input.actor.userId,
            enabled: input.enabled,
            minimized: input.minimized,
            updatedBy: input.actor.userId,
          },
          select: {
            enabled: true,
            minimized: true,
            revision: true,
            updatedAt: true,
          },
        })

    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.userId,
        actorRole: input.actor.auditRole,
        action: 'client-assistant.preference-updated',
        targetType: 'ClientAssistantPreference',
        targetId: input.actor.userId,
        ...(existing
          ? {
              beforeState: {
                enabled: existing.enabled,
                minimized: existing.minimized,
                revision: existing.revision,
              },
            }
          : {}),
        afterState: {
          enabled: preference.enabled,
          minimized: preference.minimized,
          revision: preference.revision,
        },
      },
      tx,
    )
    return preference
  })
}

export async function reserveClientAssistantTurnAction(
  rawInput: ReserveClientAssistantTurnInput,
  client: Client = db,
) {
  const input = parse(reserveTurnInput, rawInput)
  const operationHash = sha256({
    tenantId: input.tenantId,
    venueId: input.venueId,
    userId: input.actor.userId,
    behaviorVersion: input.behaviorVersion,
    userMessage: input.userMessage,
  })
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`torchiko:client-assistant-turn:${input.tenantId}:${input.operationId}`}, 0))`
    const replay = await tx.clientAssistantTurn.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        threadId: true,
        operationHash: true,
        status: true,
        behaviorVersion: true,
        userMessage: true,
        assistantMessage: true,
        questionCategory: true,
        safeActions: true,
        failureCode: true,
        revision: true,
        createdAt: true,
        completedAt: true,
        thread: { select: { userId: true } },
      },
    })
    if (replay) {
      if (
        replay.operationHash !== operationHash ||
        replay.venueId !== input.venueId ||
        replay.thread.userId !== input.actor.userId
      )
        throw new ClientAssistantActionError(
          'CONFLICT',
          'Client assistant operation was already used',
        )
      return { turn: replay, replayed: true as const }
    }

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`torchiko:client-assistant-thread:${input.tenantId}:${input.venueId}:${input.actor.userId}`}, 0))`
    await requireActiveMembership(tx, input.tenantId, input.actor.userId)
    const venue = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId, isActive: true },
      select: { id: true },
    })
    if (!venue)
      throw new ClientAssistantActionError('NOT_FOUND', 'Client assistant is not available')

    let thread = await tx.clientAssistantThread.findFirst({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        userId: input.actor.userId,
        status: 'ACTIVE',
      },
      orderBy: [{ lastActiveAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    })
    if (!thread) {
      thread = await tx.clientAssistantThread.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          userId: input.actor.userId,
        },
        select: { id: true },
      })
    }
    const lastTurn = await tx.clientAssistantTurn.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId, threadId: thread.id },
      orderBy: [{ sequence: 'desc' }],
      select: { sequence: true },
    })
    const turn = await tx.clientAssistantTurn.create({
      data: {
        operationId: input.operationId,
        operationHash,
        tenantId: input.tenantId,
        venueId: input.venueId,
        threadId: thread.id,
        sequence: (lastTurn?.sequence ?? 0) + 1,
        status: 'RESERVED',
        behaviorVersion: input.behaviorVersion,
        userMessage: input.userMessage,
      },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        threadId: true,
        operationHash: true,
        status: true,
        behaviorVersion: true,
        userMessage: true,
        assistantMessage: true,
        questionCategory: true,
        safeActions: true,
        failureCode: true,
        revision: true,
        createdAt: true,
        completedAt: true,
        thread: { select: { userId: true } },
      },
    })
    await tx.clientAssistantThread.update({
      where: { id: thread.id },
      data: { lastActiveAt: new Date(), revision: { increment: 1 } },
      select: { id: true },
    })
    return { turn, replayed: false as const }
  })
}

export async function claimClientAssistantTurnGenerationAction(
  rawInput: ClaimClientAssistantTurnInput,
  client: Client = db,
) {
  const input = parse(claimTurnInput, rawInput)
  const now = input.now ?? new Date()
  const leaseDurationMs = input.leaseDurationMs ?? 30_000
  return client.$transaction(async (tx) => {
    await lockClientAssistantGeneration(tx, input.tenantId, input.turnId)
    const turn = await tx.clientAssistantTurn.findFirst({
      where: {
        id: input.turnId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        thread: { userId: input.actor.userId },
      },
      select: {
        id: true,
        status: true,
        revision: true,
        generationLeaseId: true,
        generationLeaseExpiresAt: true,
        generationAttempts: true,
        providerDispatchedAt: true,
      },
    })
    if (!turn) throw new ClientAssistantActionError('NOT_FOUND', 'Client assistant turn not found')
    if (turn.status === 'COMPLETED' || turn.status === 'FAILED')
      throw new ClientAssistantActionError('CONFLICT', 'Client assistant turn already completed')
    const activeLease =
      turn.status === 'GENERATING' &&
      turn.generationLeaseExpiresAt !== null &&
      turn.generationLeaseExpiresAt.getTime() > now.getTime()
    if (activeLease) {
      if (turn.generationLeaseId === input.generationLeaseId)
        return { claim: turn, replayed: true as const }
      throw new ClientAssistantActionError('CONFLICT', 'A response is already being prepared')
    }

    const claimed = await tx.clientAssistantTurn.update({
      where: { id: turn.id },
      data: {
        status: 'GENERATING',
        generationLeaseId: input.generationLeaseId,
        generationLeaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
        generationAttempts: { increment: 1 },
        providerDispatchedAt: null,
        revision: { increment: 1 },
      },
      select: {
        id: true,
        status: true,
        revision: true,
        generationLeaseId: true,
        generationLeaseExpiresAt: true,
        generationAttempts: true,
        providerDispatchedAt: true,
      },
    })
    return { claim: claimed, replayed: false as const }
  })
}

export async function markClientAssistantTurnProviderDispatchedAction(
  rawInput: MarkClientAssistantTurnDispatchedInput,
  client: Client = db,
) {
  const input = parse(markDispatchedInput, rawInput)
  const dispatchedAt = input.dispatchedAt ?? new Date()
  return client.$transaction(async (tx) => {
    await lockClientAssistantGeneration(tx, input.tenantId, input.turnId)
    const turn = await tx.clientAssistantTurn.findFirst({
      where: {
        id: input.turnId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        thread: { userId: input.actor.userId },
      },
      select: {
        id: true,
        status: true,
        generationLeaseId: true,
        generationLeaseExpiresAt: true,
        providerDispatchedAt: true,
      },
    })
    if (!turn) throw new ClientAssistantActionError('NOT_FOUND', 'Client assistant turn not found')
    if (turn.status !== 'GENERATING' || turn.generationLeaseId !== input.generationLeaseId)
      throw new ClientAssistantActionError('CONFLICT', 'Client assistant generation claim changed')
    if (turn.providerDispatchedAt)
      return { dispatchedAt: turn.providerDispatchedAt, replayed: true as const }
    const updated = await tx.clientAssistantTurn.updateMany({
      where: {
        id: turn.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'GENERATING',
        generationLeaseId: input.generationLeaseId,
        providerDispatchedAt: null,
      },
      data: { providerDispatchedAt: dispatchedAt },
    })
    if (updated.count !== 1)
      throw new ClientAssistantActionError('CONFLICT', 'Client assistant generation claim changed')
    return { dispatchedAt, replayed: false as const }
  })
}

export async function completeClientAssistantTurnAction(
  rawInput: CompleteClientAssistantTurnInput,
  client: Client = db,
) {
  const input = parse(completeTurnInput, rawInput)
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`torchiko:client-assistant-complete:${input.tenantId}:${input.turnId}`}, 0))`
    const existing = await tx.clientAssistantTurn.findFirst({
      where: {
        id: input.turnId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        thread: { userId: input.actor.userId },
      },
      select: {
        id: true,
        threadId: true,
        status: true,
        revision: true,
        assistantMessage: true,
        questionCategory: true,
        safeActions: true,
        failureCode: true,
        completedAt: true,
        generationLeaseId: true,
      },
    })
    if (!existing)
      throw new ClientAssistantActionError('NOT_FOUND', 'Client assistant turn not found')
    if (existing.status === 'COMPLETED' || existing.status === 'FAILED') {
      const expectedFailure = input.outcome.status === 'FAILED' ? input.outcome.failureCode : null
      if (
        existing.assistantMessage !== input.assistantMessage ||
        existing.questionCategory !== input.questionCategory ||
        canonical(existing.safeActions) !== canonical(input.safeActions) ||
        existing.failureCode !== expectedFailure
      )
        throw new ClientAssistantActionError('CONFLICT', 'Client assistant turn already completed')
      return { turn: existing, replayed: true as const }
    }
    if (
      existing.status !== 'GENERATING' ||
      existing.revision !== input.expectedRevision ||
      existing.generationLeaseId !== input.generationLeaseId
    )
      throw new ClientAssistantActionError('CONFLICT', 'Client assistant turn changed; retry it')

    const updated = await tx.clientAssistantTurn.updateMany({
      where: {
        id: input.turnId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'GENERATING',
        revision: input.expectedRevision,
        generationLeaseId: input.generationLeaseId,
      },
      data: {
        status: input.outcome.status,
        assistantMessage: input.assistantMessage,
        questionCategory: input.questionCategory,
        safeActions: input.safeActions,
        failureCode: input.outcome.status === 'FAILED' ? input.outcome.failureCode : null,
        completedAt: new Date(),
        generationLeaseId: null,
        generationLeaseExpiresAt: null,
        revision: { increment: 1 },
      },
    })
    if (updated.count !== 1)
      throw new ClientAssistantActionError('CONFLICT', 'Client assistant turn changed; retry it')
    const turn = await tx.clientAssistantTurn.findFirst({
      where: { id: input.turnId, tenantId: input.tenantId, venueId: input.venueId },
      select: {
        id: true,
        threadId: true,
        status: true,
        revision: true,
        assistantMessage: true,
        questionCategory: true,
        safeActions: true,
        failureCode: true,
        completedAt: true,
      },
    })
    if (!turn) throw new ClientAssistantActionError('NOT_FOUND', 'Client assistant turn not found')
    await tx.clientAssistantThread.update({
      where: { id: existing.threadId },
      data: { lastActiveAt: new Date(), revision: { increment: 1 } },
      select: { id: true },
    })
    return { turn, replayed: false as const }
  })
}

export async function linkClientAssistantSupportHandoffAction(
  rawInput: LinkClientAssistantHandoffInput,
  client: Client = db,
) {
  const input = parse(handoffInput, rawInput)
  const operationHash = sha256({
    tenantId: input.tenantId,
    venueId: input.venueId,
    turnId: input.turnId,
    supportRequestId: input.supportRequestId,
    summarySnapshot: input.summarySnapshot,
    confirmedByUserId: input.actor.userId,
  })
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`torchiko:client-assistant-handoff:${input.tenantId}:${input.operationId}`}, 0))`
    const replay = await tx.clientAssistantSupportHandoff.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
      select: {
        id: true,
        operationHash: true,
        turnId: true,
        supportRequestId: true,
        confirmationState: true,
        confirmedAt: true,
      },
    })
    if (replay) {
      if (replay.operationHash !== operationHash)
        throw new ClientAssistantActionError(
          'CONFLICT',
          'Client assistant handoff operation was already used',
        )
      return { handoff: replay, replayed: true as const }
    }
    const [turn, request, membership] = await Promise.all([
      tx.clientAssistantTurn.findFirst({
        where: {
          id: input.turnId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          status: 'COMPLETED',
          thread: { userId: input.actor.userId },
        },
        select: { id: true, safeActions: true },
      }),
      tx.supportRequest.findFirst({
        where: {
          id: input.supportRequestId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          requesterUserId: input.actor.userId,
        },
        select: { id: true },
      }),
      tx.tenantMembership.findFirst({
        where: { tenantId: input.tenantId, userId: input.actor.userId, status: 'ACTIVE' },
        select: { id: true },
      }),
    ])
    if (!turn || !request || !membership)
      throw new ClientAssistantActionError('NOT_FOUND', 'Confirmed handoff is not available')
    const safeActions = Array.isArray(turn.safeActions) ? turn.safeActions : []
    const matchingPreview = safeActions.some((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
      const action = candidate as Record<string, unknown>
      return (
        action.type === 'preview-support-handoff' &&
        action.category === input.summarySnapshot.category &&
        action.summary === input.summarySnapshot.summary &&
        action.requestedOutcome === input.summarySnapshot.requestedOutcome
      )
    })
    if (!matchingPreview)
      throw new ClientAssistantActionError('CONFLICT', 'Handoff preview changed; review it again')

    const handoff = await tx.clientAssistantSupportHandoff.create({
      data: {
        operationId: input.operationId,
        operationHash,
        tenantId: input.tenantId,
        venueId: input.venueId,
        turnId: input.turnId,
        supportRequestId: input.supportRequestId,
        summarySnapshot: input.summarySnapshot,
        confirmedByUserId: input.actor.userId,
        confirmedAt: new Date(),
      },
      select: {
        id: true,
        operationHash: true,
        turnId: true,
        supportRequestId: true,
        confirmationState: true,
        confirmedAt: true,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.userId,
        actorRole: input.actor.auditRole,
        action: 'client-assistant.handoff-confirmed',
        targetType: 'SupportRequest',
        targetId: input.supportRequestId,
        afterState: {
          venueId: input.venueId,
          turnId: input.turnId,
          handoffId: handoff.id,
          category: input.summarySnapshot.category,
          source: 'CLIENT_TOCHI',
        },
      },
      tx,
    )
    return { handoff, replayed: false as const }
  })
}
