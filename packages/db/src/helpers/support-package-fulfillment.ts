import { createHash } from 'node:crypto'

import {
  SupportCompletionPackageFulfillment,
  type SupportCompletionPackageFulfillment as SupportCompletionPackageFulfillmentValue,
} from '@pathfinder/contracts'

import { db } from '../client'

type TransactionClient = Parameters<Parameters<typeof db.$transaction>[0]>[0]
type FulfillmentReader = Pick<TransactionClient, 'supportPackageHandoff'>

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
  value: Omit<SupportCompletionPackageFulfillmentValue, 'digest'>,
): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
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
  const identity = {
    contractVersion: 1 as const,
    linkedPackageCount: packages.length,
    packages,
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
  return left.digest === right.digest && canonicalJson(left) === canonicalJson(right)
}
