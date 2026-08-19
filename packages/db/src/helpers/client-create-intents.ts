import { db } from '../client'

export type ClientCreateIntentActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}
export type ClientCreateIntentClient = Pick<typeof db, '$transaction'>

export class ClientCreateIntentError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'NOT_FOUND' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'ClientCreateIntentError'
  }
}

type Identity = {
  requestId: string
  requestHash: string
  actor: ClientCreateIntentActor
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function requireIdentity(input: Identity): void {
  if (
    input.actor.type !== 'HUMAN' ||
    input.actor.role !== 'PLATFORM_ADMIN' ||
    !input.actor.id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.requestId,
    ) ||
    !/^[0-9a-f]{64}$/u.test(input.requestHash)
  ) {
    throw new ClientCreateIntentError('INVALID_INPUT', 'Valid client-create identity is required')
  }
}

function sameRequest(intent: { requestHash: string; actorId: string }, input: Identity): void {
  if (intent.requestHash !== input.requestHash || intent.actorId !== input.actor.id) {
    throw new ClientCreateIntentError(
      'CONFLICT',
      'This client-create request ID is already bound to different input or actor',
    )
  }
}

async function append(
  tx: typeof db,
  intentId: string,
  status: 'RESERVED' | 'PROVIDER_STARTED' | 'PROVIDER_CONFIRMED' | 'COMPLETED',
  actorId: string,
) {
  await tx.clientCreateIntentEvent.create({ data: { intentId, status, actorId } })
}

async function lockRequest(tx: typeof db, requestId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:client-create-intent:${requestId}`}, 0))`
}

export async function beginClientCreateIntentAction(
  input: Identity,
  client: ClientCreateIntentClient = db,
) {
  requireIdentity(input)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await lockRequest(tx, input.requestId)
    let intent = await tx.clientCreateIntent.findUnique({ where: { requestId: input.requestId } })
    if (!intent) {
      intent = await tx.clientCreateIntent.create({
        data: {
          requestId: input.requestId,
          requestHash: input.requestHash,
          actorId: input.actor.id,
        },
      })
      await append(tx, intent.id, 'RESERVED', input.actor.id)
    }
    sameRequest(intent, input)
    if (intent.status === 'COMPLETED') {
      return {
        state: 'COMPLETED' as const,
        tenantId: intent.completedTenantId!,
        venueId: intent.completedVenueId!,
        createdAt: intent.createdAt,
      }
    }
    if (intent.status === 'PROVIDER_CONFIRMED') {
      return {
        state: 'PROVIDER_CONFIRMED' as const,
        providerOrganizationId: intent.providerOrganizationId!,
        localSlug: intent.localSlug!,
        createdAt: intent.createdAt,
      }
    }
    if (intent.status === 'PROVIDER_STARTED') {
      return { state: 'RECONCILIATION_REQUIRED' as const, createdAt: intent.createdAt }
    }
    return { state: 'READY' as const, createdAt: intent.createdAt }
  })
}

export async function startClientCreateProviderAction(
  input: Identity & { localSlug: string },
  client: ClientCreateIntentClient = db,
) {
  requireIdentity(input)
  if (!input.localSlug) {
    throw new ClientCreateIntentError('INVALID_INPUT', 'Local client slug is required')
  }
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await lockRequest(tx, input.requestId)
    const intent = await tx.clientCreateIntent.findUnique({ where: { requestId: input.requestId } })
    if (!intent) throw new ClientCreateIntentError('NOT_FOUND', 'Client-create intent not found')
    sameRequest(intent, input)
    if (intent.status !== 'RESERVED') {
      return { state: 'RECONCILIATION_REQUIRED' as const }
    }
    const changed = await tx.clientCreateIntent.updateMany({
      where: { id: intent.id, status: 'RESERVED' },
      data: { status: 'PROVIDER_STARTED', localSlug: input.localSlug },
    })
    if (changed.count !== 1) {
      throw new ClientCreateIntentError('CONFLICT', 'Client-create intent changed unexpectedly')
    }
    await append(tx, intent.id, 'PROVIDER_STARTED', input.actor.id)
    return { state: 'CALL_PROVIDER' as const }
  })
}

export async function confirmClientCreateProviderAction(
  input: Identity & { providerOrganizationId: string },
  client: ClientCreateIntentClient = db,
) {
  requireIdentity(input)
  if (!input.providerOrganizationId) {
    throw new ClientCreateIntentError('INVALID_INPUT', 'Provider organization ID is required')
  }
  try {
    return await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const intent = await tx.clientCreateIntent.findUnique({
        where: { requestId: input.requestId },
      })
      if (!intent) throw new ClientCreateIntentError('NOT_FOUND', 'Client-create intent not found')
      sameRequest(intent, input)
      if (
        ['PROVIDER_CONFIRMED', 'COMPLETED'].includes(intent.status) &&
        intent.providerOrganizationId === input.providerOrganizationId
      ) {
        return intent
      }
      if (intent.status !== 'PROVIDER_STARTED') {
        throw new ClientCreateIntentError('CONFLICT', 'Client-create intent cannot be confirmed')
      }
      const changed = await tx.clientCreateIntent.updateMany({
        where: { id: intent.id, status: 'PROVIDER_STARTED', providerOrganizationId: null },
        data: {
          status: 'PROVIDER_CONFIRMED',
          providerOrganizationId: input.providerOrganizationId,
        },
      })
      if (changed.count !== 1) {
        throw new ClientCreateIntentError('CONFLICT', 'Client-create provider claim changed')
      }
      await append(tx, intent.id, 'PROVIDER_CONFIRMED', input.actor.id)
      return {
        ...intent,
        status: 'PROVIDER_CONFIRMED' as const,
        providerOrganizationId: input.providerOrganizationId,
      }
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ClientCreateIntentError(
        'CONFLICT',
        'Provider organization is already claimed by another client-create request',
      )
    }
    throw error
  }
}

export async function completeClientCreateIntentAction(
  input: Identity & { providerOrganizationId: string; tenantId: string; venueId: string },
  client: ClientCreateIntentClient = db,
) {
  requireIdentity(input)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const intent = await tx.clientCreateIntent.findUnique({ where: { requestId: input.requestId } })
    if (!intent) throw new ClientCreateIntentError('NOT_FOUND', 'Client-create intent not found')
    sameRequest(intent, input)
    if (
      intent.status === 'COMPLETED' &&
      intent.completedTenantId === input.tenantId &&
      intent.completedVenueId === input.venueId
    )
      return intent
    if (
      intent.status !== 'PROVIDER_CONFIRMED' ||
      intent.providerOrganizationId !== input.providerOrganizationId ||
      input.tenantId !== input.providerOrganizationId
    ) {
      throw new ClientCreateIntentError(
        'CONFLICT',
        'Client-create completion identity does not match',
      )
    }
    const changed = await tx.clientCreateIntent.updateMany({
      where: {
        id: intent.id,
        status: 'PROVIDER_CONFIRMED',
        providerOrganizationId: input.providerOrganizationId,
      },
      data: {
        status: 'COMPLETED',
        completedTenantId: input.tenantId,
        completedVenueId: input.venueId,
      },
    })
    if (changed.count !== 1) {
      throw new ClientCreateIntentError('CONFLICT', 'Client-create completion raced')
    }
    await append(tx, intent.id, 'COMPLETED', input.actor.id)
    return { ...intent, status: 'COMPLETED' as const }
  })
}
