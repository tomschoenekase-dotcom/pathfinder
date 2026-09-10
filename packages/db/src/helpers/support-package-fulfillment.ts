import { createHash } from 'node:crypto'

import {
  SupportCompletionPackageFulfillment,
  type SupportCompletionPackageFulfillment as SupportCompletionPackageFulfillmentValue,
} from '@pathfinder/contracts'

import { db } from '../client'
import { lockVenueContentMutation } from './venue-content-lock'
import { lockSupportRequest } from './support-request-lock'
import {
  readSupportTemporalFulfillment,
  SupportTemporalFulfillmentError,
  type SupportTemporalFulfillmentReader,
} from './support-temporal-fulfillment'
import {
  readSupportContentFulfillment,
  SupportContentFulfillmentError,
  type SupportContentFulfillmentReader,
} from './support-content-fulfillment'
import {
  readSupportPackageGuestObservability,
  SupportPackageObservabilityError,
  type SupportPackageObservabilityReader,
} from './support-package-observability'

type TransactionClient = Parameters<Parameters<typeof db.$transaction>[0]>[0]
type FulfillmentReader = Pick<TransactionClient, 'supportPackageHandoff' | '$executeRaw'> &
  SupportPackageObservabilityReader &
  SupportContentFulfillmentReader &
  SupportTemporalFulfillmentReader

export class SupportPackageFulfillmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SupportPackageFulfillmentError'
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function supportPackageFulfillmentDigest(
  value:
    | Omit<Extract<SupportCompletionPackageFulfillmentValue, { contractVersion: 1 }>, 'digest'>
    | Omit<Extract<SupportCompletionPackageFulfillmentValue, { contractVersion: 2 }>, 'digest'>
    | Omit<Extract<SupportCompletionPackageFulfillmentValue, { contractVersion: 3 }>, 'digest'>
    | Omit<Extract<SupportCompletionPackageFulfillmentValue, { contractVersion: 4 }>, 'digest'>
    | Omit<Extract<SupportCompletionPackageFulfillmentValue, { contractVersion: 5 }>, 'digest'>,
): string {
  const normalized =
    value.contractVersion !== 1
      ? {
          ...value,
          ...('temporalFulfillment' in value
            ? { temporalFulfillment: { ...value.temporalFulfillment, verifiedAt: null } }
            : {}),
          guestObservability: { ...value.guestObservability, verifiedAt: null },
          ...('contentFulfillment' in value
            ? { contentFulfillment: { ...value.contentFulfillment, verifiedAt: null } }
            : {}),
        }
      : value
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex')
}

/** Reads the exact current package fulfillment for one support request. Immutable
 * handoffs that have append-only supersession evidence remain historical truth but
 * no longer represent current fulfillment. Package-free requests remain eligible.
 * If any current handoff is not fully APPLIED, completion must stop instead of
 * telling the client that unfinished work is complete. */
export async function readSupportPackageFulfillment(
  client: FulfillmentReader,
  input: { tenantId: string; venueId: string; supportRequestId: string },
): Promise<SupportCompletionPackageFulfillmentValue> {
  // Same order for preparation, MCP execution and manual completion: request -> venue -> entities.
  await lockSupportRequest(client, input.tenantId, input.supportRequestId)
  await lockVenueContentMutation(client, input)
  const handoffs = await client.supportPackageHandoff.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      supportRequestId: input.supportRequestId,
      supersessionAsPrior: { is: null },
    },
    orderBy: [{ venuePackageId: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      venuePackageId: true,
      requestVersion: true,
      venuePackage: {
        select: {
          status: true,
          payloadHash: true,
          appliedAt: true,
          appliedBy: true,
          appliedCommandKey: true,
          updatedAt: true,
          schemaVersion: true,
          appliedEntities: true,
        },
      },
    },
  })

  const incomplete = handoffs.find(
    ({ venuePackage }) =>
      venuePackage.status !== 'APPLIED' ||
      !venuePackage.appliedAt ||
      !venuePackage.appliedBy ||
      !venuePackage.appliedCommandKey,
  )
  if (incomplete) {
    throw new SupportPackageFulfillmentError(
      `Linked venue package ${incomplete.venuePackageId} is not fully applied.`,
    )
  }

  const packages = handoffs.map(({ id, venuePackageId, requestVersion, venuePackage }) => ({
    handoffId: id,
    packageId: venuePackageId,
    handoffRequestVersion: requestVersion,
    status: 'APPLIED' as const,
    payloadHash: venuePackage.payloadHash,
    appliedAt: venuePackage.appliedAt!.toISOString(),
    appliedBy: venuePackage.appliedBy!,
    appliedCommandKey: venuePackage.appliedCommandKey!,
    packageUpdatedAt: venuePackage.updatedAt.toISOString(),
  }))
  let guestObservability
  let contentFulfillment
  let temporalFulfillment
  try {
    guestObservability = await readSupportPackageGuestObservability({
      client,
      tenantId: input.tenantId,
      venueId: input.venueId,
      packages: handoffs.map(({ venuePackageId, venuePackage }) => ({
        packageId: venuePackageId,
        schemaVersion: venuePackage.schemaVersion,
        appliedEntities: venuePackage.appliedEntities,
      })),
    })
    temporalFulfillment = await readSupportTemporalFulfillment(client, input)
    contentFulfillment = await readSupportContentFulfillment(client, {
      ...input,
      verifiedPackageIds: packages.map(({ packageId }) => packageId),
      verifiedTemporalProposalIds: temporalFulfillment.receipts.map(({ proposalId }) => proposalId),
    })
  } catch (error) {
    if (
      error instanceof SupportPackageObservabilityError ||
      error instanceof SupportContentFulfillmentError ||
      error instanceof SupportTemporalFulfillmentError
    )
      throw new SupportPackageFulfillmentError(error.message)
    throw error
  }
  const identity = {
    contractVersion: 5 as const,
    linkedPackageCount: packages.length,
    packages,
    guestObservability,
    contentFulfillment,
    temporalFulfillment,
  }
  return SupportCompletionPackageFulfillment.parse({
    ...identity,
    digest: supportPackageFulfillmentDigest(identity),
  })
}

export function sameSupportPackageFulfillment(
  left: SupportCompletionPackageFulfillmentValue,
  right: SupportCompletionPackageFulfillmentValue,
): boolean {
  if (left.contractVersion === 1 || right.contractVersion === 1) {
    return (
      left.linkedPackageCount === 0 &&
      right.linkedPackageCount === 0 &&
      (!('contentFulfillment' in left) || left.contentFulfillment.receipts.length === 0) &&
      (!('temporalFulfillment' in left) || left.temporalFulfillment.receipts.length === 0) &&
      (!('contentFulfillment' in right) || right.contentFulfillment.receipts.length === 0) &&
      (!('temporalFulfillment' in right) || right.temporalFulfillment.receipts.length === 0)
    )
  }
  const withoutVerificationTime = (
    value: Extract<
      SupportCompletionPackageFulfillmentValue,
      {
        contractVersion: 2 | 3 | 4 | 5
      }
    >,
  ) => ({
    ...value,
    ...('temporalFulfillment' in value
      ? { temporalFulfillment: { ...value.temporalFulfillment, verifiedAt: null } }
      : {}),
    guestObservability: { ...value.guestObservability, verifiedAt: null },
    ...('contentFulfillment' in value
      ? { contentFulfillment: { ...value.contentFulfillment, verifiedAt: null } }
      : {}),
  })
  return (
    left.digest === right.digest &&
    canonicalJson(withoutVerificationTime(left)) === canonicalJson(withoutVerificationTime(right))
  )
}

/** Natural expiry is not prevented by locks; recheck immediately before the completion write. */
export function assertSupportFulfillmentEffectiveAt(
  value: SupportCompletionPackageFulfillmentValue,
  now: Date,
): void {
  if (!Number.isFinite(now.getTime()))
    throw new SupportPackageFulfillmentError('Invalid completion time.')
  if (
    value.contractVersion === 5 &&
    value.contentFulfillment.receipts.some(
      (receipt) =>
        receipt.state === 'CURRENT' &&
        ((receipt.effectiveFrom !== null && Date.parse(receipt.effectiveFrom) > now.getTime()) ||
          (receipt.effectiveUntil !== null &&
            Date.parse(receipt.effectiveUntil) <= now.getTime()) ||
          (receipt.operationalFactExpiresAt !== null &&
            Date.parse(receipt.operationalFactExpiresAt) <= now.getTime())),
    )
  )
    throw new SupportPackageFulfillmentError(
      'Content fulfillment is no longer currently effective; refresh completion evidence.',
    )
  if (!('temporalFulfillment' in value)) return
  if (
    value.temporalFulfillment.receipts.some(
      (receipt) =>
        Date.parse(receipt.startsAt) > now.getTime() ||
        Date.parse(receipt.expiresAt) <= now.getTime(),
    )
  )
    throw new SupportPackageFulfillmentError(
      'Temporal fulfillment is no longer currently effective; refresh completion evidence.',
    )
}
