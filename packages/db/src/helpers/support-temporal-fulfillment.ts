import { createHash } from 'node:crypto'

import { db } from '../client'
import { lockContentVersionEntity } from './content-version-context'
import { MAX_GUEST_OPERATIONAL_UPDATES } from './operational-update-actions'
import {
  readSupportFulfillmentSources,
  SupportFulfillmentSourceError,
  type SupportFulfillmentSourceReader,
} from './support-fulfillment-sources'

type TransactionClient = Parameters<Parameters<typeof db.$transaction>[0]>[0]
export type SupportTemporalFulfillmentReader = SupportFulfillmentSourceReader &
  Pick<
    TransactionClient,
    'knowledgeProposalOperationalUpdateHandoff' | 'operationalUpdate' | '$executeRaw' | '$queryRaw'
  >

export class SupportTemporalFulfillmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SupportTemporalFulfillmentError'
  }
}

export type SupportTemporalFulfillment = {
  contractVersion: 1
  receipts: Array<{
    handoffId: string
    proposalId: string
    sourceProposalId: string
    sourceRequestVersion: number
    operationalUpdateId: string
    updatedAt: string
    publishedAt: string
    startsAt: string
    expiresAt: string
    observedStateHash: string
  }>
  verifiedAt: string
  digest: string
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export function supportTemporalFulfillmentDigest(
  value: Omit<SupportTemporalFulfillment, 'digest' | 'verifiedAt'>,
) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export async function readSupportTemporalFulfillment(
  client: SupportTemporalFulfillmentReader,
  input: { tenantId: string; venueId: string; supportRequestId: string; asOf?: Date },
): Promise<SupportTemporalFulfillment> {
  const sources = await readSupportFulfillmentSources(client, input).catch((error) => {
    if (error instanceof SupportFulfillmentSourceError)
      throw new SupportTemporalFulfillmentError(error.message)
    throw error
  })
  if (sources.length === 0) {
    const asOf = input.asOf ?? new Date()
    if (!Number.isFinite(asOf.getTime()))
      throw new SupportTemporalFulfillmentError('Invalid verification time.')
    const identity = { contractVersion: 1 as const, receipts: [] }
    return {
      ...identity,
      verifiedAt: asOf.toISOString(),
      digest: supportTemporalFulfillmentDigest(identity),
    }
  }
  const proposalIds = sources.map(({ proposalId }) => proposalId)
  const initial = await client.knowledgeProposalOperationalUpdateHandoff.findMany({
    where: { tenantId: input.tenantId, venueId: input.venueId, proposalId: { in: proposalIds } },
    select: { id: true, proposalId: true, operationalUpdateId: true },
    orderBy: { id: 'asc' },
    take: 101,
  })
  if (initial.length > 100)
    throw new SupportTemporalFulfillmentError('Temporal receipt count exceeds 100.')
  for (const id of [
    ...new Set(initial.map(({ operationalUpdateId }) => operationalUpdateId)),
  ].sort())
    await lockContentVersionEntity(client, {
      tenantId: input.tenantId,
      entityType: 'OPERATIONAL_UPDATE',
      entityId: id,
    })
  const asOf = input.asOf ?? new Date()
  if (!Number.isFinite(asOf.getTime()))
    throw new SupportTemporalFulfillmentError('Invalid verification time.')

  const handoffs = await client.knowledgeProposalOperationalUpdateHandoff.findMany({
    where: { tenantId: input.tenantId, venueId: input.venueId, proposalId: { in: proposalIds } },
    orderBy: { id: 'asc' },
    take: 101,
    select: { id: true, proposalId: true, operationalUpdateId: true },
  })
  if (handoffs.length > 100)
    throw new SupportTemporalFulfillmentError('Temporal receipt count exceeds 100.')
  const initialIdentity = new Set(
    initial.map(
      ({ id, proposalId, operationalUpdateId }) => `${id}:${proposalId}:${operationalUpdateId}`,
    ),
  )
  const finalIdentity = new Set(
    handoffs.map(
      ({ id, proposalId, operationalUpdateId }) => `${id}:${proposalId}:${operationalUpdateId}`,
    ),
  )
  if (
    initialIdentity.size !== finalIdentity.size ||
    [...initialIdentity].some((identity) => !finalIdentity.has(identity))
  )
    throw new SupportTemporalFulfillmentError(
      'Temporal receipt set changed while acquiring verification locks; retry completion evidence.',
    )
  if (handoffs.length === 0) {
    const identity = { contractVersion: 1 as const, receipts: [] }
    return {
      ...identity,
      verifiedAt: asOf.toISOString(),
      digest: supportTemporalFulfillmentDigest(identity),
    }
  }
  const visible = await client.operationalUpdate.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      status: 'PUBLISHED',
      isActive: true,
      startsAt: { lte: asOf },
      expiresAt: { gt: asOf },
      OR: [{ placeId: null }, { place: { visibility: 'PUBLIC' } }],
    },
    select: {
      id: true,
      placeId: true,
      updateType: true,
      severity: true,
      priority: true,
      title: true,
      body: true,
      redirectTo: true,
      updatedAt: true,
      publishedAt: true,
      startsAt: true,
      expiresAt: true,
      place: { select: { id: true, tenantId: true, venueId: true, name: true, visibility: true } },
    },
    orderBy: [{ priority: 'desc' }, { startsAt: 'desc' }, { id: 'asc' }],
    take: MAX_GUEST_OPERATIONAL_UPDATES,
  })
  const visibleById = new Map(visible.map((item) => [item.id, item]))
  const sourceByProposal = new Map(sources.map((source) => [source.proposalId, source]))
  const receipts = handoffs
    .map((handoff) => {
      const source = sourceByProposal.get(handoff.proposalId)
      const update = visibleById.get(handoff.operationalUpdateId)
      if (!source || !update || !update.publishedAt)
        throw new SupportTemporalFulfillmentError(
          'A source-bound temporal update is not currently guest observable.',
        )
      if (
        (update.placeId === null && update.place !== null) ||
        (update.placeId !== null &&
          (!update.place ||
            update.place.id !== update.placeId ||
            update.place.tenantId !== input.tenantId ||
            update.place.venueId !== input.venueId ||
            update.place.visibility !== 'PUBLIC'))
      )
        throw new SupportTemporalFulfillmentError(
          'A source-bound temporal update place is not in the exact public guest scope.',
        )
      const observed = {
        id: update.id,
        placeId: update.placeId,
        placeName: update.place?.name ?? null,
        updateType: update.updateType,
        severity: update.severity,
        priority: update.priority,
        title: update.title,
        body: update.body,
        redirectTo: update.redirectTo,
      }
      return {
        handoffId: handoff.id,
        proposalId: handoff.proposalId,
        sourceProposalId: source.sourceProposalId,
        sourceRequestVersion: source.sourceRequestVersion,
        operationalUpdateId: update.id,
        updatedAt: update.updatedAt.toISOString(),
        publishedAt: update.publishedAt.toISOString(),
        startsAt: update.startsAt.toISOString(),
        expiresAt: update.expiresAt.toISOString(),
        observedStateHash: createHash('sha256').update(canonical(observed)).digest('hex'),
      }
    })
    .sort((a, b) => a.handoffId.localeCompare(b.handoffId))
  const identity = { contractVersion: 1 as const, receipts }
  return {
    ...identity,
    verifiedAt: asOf.toISOString(),
    digest: supportTemporalFulfillmentDigest(identity),
  }
}
