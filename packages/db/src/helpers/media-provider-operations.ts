import { createHash, randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

export const MEDIA_PROVIDER_OPERATION_LEASE_MS = 5 * 60_000

export type MediaProviderOperationIdentity = {
  tenantId: string
  venueId: string
  projectId: string
  uploadAttemptId: string
  sourceId: string
  provider: string
  model: string
  method: string
  inputSha256: string
  promptSha256: string
  extractionSchemaVersion: string
  plannedProviderFileName: string
}

function immutableMatch(
  row: Awaited<ReturnType<typeof findOperation>>,
  input: MediaProviderOperationIdentity,
) {
  return Boolean(
    row &&
    row.venueId === input.venueId &&
    row.provider === input.provider &&
    row.model === input.model &&
    row.inputSha256 === input.inputSha256 &&
    row.promptSha256 === input.promptSha256 &&
    row.extractionSchemaVersion === input.extractionSchemaVersion &&
    row.plannedProviderFileName === input.plannedProviderFileName,
  )
}

function findOperation(
  input: Pick<
    MediaProviderOperationIdentity,
    'tenantId' | 'projectId' | 'uploadAttemptId' | 'sourceId' | 'method'
  >,
) {
  return db.mediaProviderOperation.findFirst({
    where: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      uploadAttemptId: input.uploadAttemptId,
      sourceId: input.sourceId,
      method: input.method,
    },
  })
}

export async function prepareMediaProviderOperation(input: MediaProviderOperationIdentity) {
  return withTenantIsolationBypass(async () => {
    let row = await findOperation(input)
    if (!row) {
      try {
        row = await db.mediaProviderOperation.create({ data: input })
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
          throw error
        row = await findOperation(input)
      }
    }
    if (!immutableMatch(row, input)) throw new Error('media-provider-operation-identity-conflict')
    return row!
  })
}

export async function claimMediaProviderOperation(params: {
  id: string
  tenantId: string
  now?: Date
}) {
  const now = params.now ?? new Date()
  const leaseToken = randomUUID()
  const leaseExpiresAt = new Date(now.getTime() + MEDIA_PROVIDER_OPERATION_LEASE_MS)
  return withTenantIsolationBypass(async () => {
    const claimed = await db.mediaProviderOperation.updateMany({
      where: {
        id: params.id,
        tenantId: params.tenantId,
        OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: { leaseToken, leaseExpiresAt, revision: { increment: 1 } },
    })
    if (claimed.count !== 1) return null
    const operation = await db.mediaProviderOperation.findFirstOrThrow({
      where: { id: params.id, tenantId: params.tenantId, leaseToken },
    })
    return { leaseToken, leaseExpiresAt, revision: operation.revision, operation }
  })
}

type Fence = { id: string; tenantId: string; leaseToken: string; revision: number }

async function fencedUpdate(
  fence: Fence,
  expected: Prisma.MediaProviderOperationWhereInput,
  data: Prisma.MediaProviderOperationUpdateManyMutationInput,
) {
  const updated = await withTenantIsolationBypass(() =>
    db.mediaProviderOperation.updateMany({
      where: { ...fence, ...expected, leaseExpiresAt: { gt: new Date() } },
      data: { ...data, revision: { increment: 1 } },
    }),
  )
  if (updated.count !== 1) throw new Error('media-provider-operation-fence-lost')
  return fence.revision + 1
}

export function markMediaProviderOperationDispatched(
  fence: Fence,
  reservationId: string,
  invocationAt = new Date(),
) {
  if (!Number.isFinite(invocationAt.getTime()))
    throw new Error('media-provider-invocation-time-invalid')
  return fencedUpdate(
    fence,
    {
      dispatchState: 'PREPARED',
      outcomeState: 'PENDING',
      cleanupState: 'NOT_REQUIRED',
      accountingState: 'NOT_REQUIRED',
    },
    {
      dispatchState: 'DISPATCHED',
      cleanupState: 'PENDING',
      accountingState: 'PENDING',
      budgetReservationId: reservationId,
      dispatchedAt: invocationAt,
    },
  )
}

export function recordMediaProviderOperationOutput(
  fence: Fence,
  params: { result: unknown; responseText: string; usage: unknown },
) {
  const resultText = JSON.stringify(params.result)
  const usageText = JSON.stringify(params.usage)
  if (!resultText || Buffer.byteLength(resultText) > 1_000_000)
    throw new Error('media-provider-result-too-large')
  if (!usageText || Buffer.byteLength(usageText) > 16_384)
    throw new Error('media-provider-usage-too-large')
  return fencedUpdate(
    fence,
    { dispatchState: 'DISPATCHED', outcomeState: 'PENDING' },
    {
      outcomeState: 'OBSERVED',
      result: JSON.parse(resultText) as Prisma.InputJsonValue,
      responseSha256: createHash('sha256').update(params.responseText).digest('hex'),
      usage: JSON.parse(usageText) as Prisma.InputJsonValue,
      outputObservedAt: new Date(),
    },
  )
}

export function markMediaProviderOperationAmbiguous(fence: Fence, errorCode: string) {
  return fencedUpdate(
    fence,
    { dispatchState: 'DISPATCHED', outcomeState: 'PENDING', cleanupState: 'PENDING' },
    { outcomeState: 'AMBIGUOUS', errorCode },
  )
}

export function confirmMediaProviderOperationCleanup(fence: Fence) {
  return fencedUpdate(
    fence,
    { dispatchState: 'DISPATCHED', cleanupState: 'PENDING' },
    {
      cleanupState: 'CONFIRMED',
      cleanupConfirmedAt: new Date(),
    },
  )
}

export async function releaseMediaProviderOperation(fence: Fence) {
  const released = await withTenantIsolationBypass(() =>
    db.mediaProviderOperation.updateMany({
      where: {
        ...fence,
        OR: [
          { dispatchState: 'PREPARED' },
          { cleanupState: 'CONFIRMED', accountingState: { not: 'PENDING' } },
          { cleanupState: 'PENDING' },
        ],
      },
      data: { leaseToken: null, leaseExpiresAt: null, revision: { increment: 1 } },
    }),
  )
  return released.count === 1
}

export function settleMediaProviderOperationAccounting(
  fence: Fence,
  state: 'SETTLED' | 'AMBIGUOUS',
) {
  return fencedUpdate(
    fence,
    { dispatchState: 'DISPATCHED', accountingState: 'PENDING' },
    {
      accountingState: state,
    },
  )
}

export async function heartbeatMediaProviderOperation(fence: Fence) {
  const leaseExpiresAt = new Date(Date.now() + MEDIA_PROVIDER_OPERATION_LEASE_MS)
  const updated = await withTenantIsolationBypass(() =>
    db.mediaProviderOperation.updateMany({
      where: { ...fence, leaseExpiresAt: { gt: new Date() } },
      data: { leaseExpiresAt },
    }),
  )
  return updated.count === 1 ? leaseExpiresAt : null
}
