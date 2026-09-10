import { createHash } from 'node:crypto'

import { nativeCoreVisibleStateHash } from '@pathfinder/contracts'

import { db } from '../client'
import {
  applyNativeGuestContentRead,
  resolveNativeGuestReadSnapshotAction,
  type NativeGuestReadPath,
} from './native-guest-content-read'
import {
  readSupportFulfillmentSources,
  SupportFulfillmentSourceError,
  type SupportFulfillmentSourceReader,
} from './support-fulfillment-sources'

type TransactionClient = Parameters<Parameters<typeof db.$transaction>[0]>[0]

export type SupportContentFulfillment = {
  contractVersion: 1
  receipts: Array<{
    receiptKind: 'UNIVERSAL' | 'ADOPTION'
    receiptId: string
    proposalId: string
    sourceProposalId: string
    sourceRequestVersion: number
    moduleId: string
    revisionId: string
    publicationId: string
    projectionId: string
    observedStateHash: string
  }>
  guestRead: {
    path: NativeGuestReadPath | 'NOT_APPLICABLE'
    releaseId: string | null
    nativeStateHash: string | null
  }
  verifiedAt: string
  digest: string
}

export type SupportContentFulfillmentReader = Pick<
  TransactionClient,
  | 'knowledgeProposalUniversalContentHandoff'
  | 'legacyKnowledgeUniversalContentAdoption'
  | 'venueKnowledgeEntry'
  | 'tenantFeatureFlag'
  | 'nativeVenueDeploymentHead'
  | 'nativeVenueDeploymentEvaluationEvidence'
> &
  SupportFulfillmentSourceReader

const MAX_RECEIPTS = 100

export class SupportContentFulfillmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SupportContentFulfillmentError'
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export function supportContentFulfillmentDigest(
  value: Omit<SupportContentFulfillment, 'digest' | 'verifiedAt'>,
): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

type Receipt = {
  receiptKind: 'UNIVERSAL' | 'ADOPTION'
  id: string
  proposalId: string
  moduleId: string
  revisionId: string
  module: {
    revisions: Array<{ id: string; version: number }>
    publications: Array<{ id: string; revisionId: string; action: 'PUBLISH' | 'WITHDRAW' }>
  }
  revision: {
    audience: 'PUBLIC' | 'CLIENT' | 'OPERATOR'
    effectiveFrom: Date | null
    effectiveUntil: Date | null
    operationalFact: { expiresAt: Date | null } | null
  }
}

function receiptKey(receipt: Receipt) {
  return `${receipt.proposalId}:${receipt.moduleId}`
}

function assertCurrentPublicReceipt(receipt: Receipt, asOf: Date): string {
  const latestRevision = receipt.module.revisions[0]
  const latestPublication = receipt.module.publications[0]
  if (!latestRevision || latestRevision.id !== receipt.revisionId)
    throw new SupportContentFulfillmentError(`Content receipt ${receipt.id} is stale.`)
  if (
    !latestPublication ||
    latestPublication.action !== 'PUBLISH' ||
    latestPublication.revisionId !== receipt.revisionId
  )
    throw new SupportContentFulfillmentError(
      `Content receipt ${receipt.id} is not currently published.`,
    )
  if (receipt.revision.audience !== 'PUBLIC')
    throw new SupportContentFulfillmentError(`Content receipt ${receipt.id} is not public.`)
  if (
    (receipt.revision.effectiveFrom && receipt.revision.effectiveFrom > asOf) ||
    (receipt.revision.effectiveUntil && receipt.revision.effectiveUntil <= asOf) ||
    (receipt.revision.operationalFact?.expiresAt &&
      receipt.revision.operationalFact.expiresAt <= asOf)
  )
    throw new SupportContentFulfillmentError(
      `Content receipt ${receipt.id} is not currently effective.`,
    )
  return latestPublication.id
}

/**
 * Reads only source-bound universal-content fulfillment. A draft, withdrawal, stale revision,
 * missing public projection, or ambiguous receipt fails closed; it never publishes or repairs it.
 */
export async function readSupportContentFulfillment(
  client: SupportContentFulfillmentReader,
  input: {
    tenantId: string
    venueId: string
    supportRequestId: string
    verifiedPackageIds?: string[]
    verifiedTemporalProposalIds?: string[]
    asOf?: Date
  },
): Promise<SupportContentFulfillment> {
  const asOf = input.asOf ?? new Date()
  if (!Number.isFinite(asOf.getTime()))
    throw new SupportContentFulfillmentError('Invalid verification time.')
  const sources = await readSupportFulfillmentSources(client, input).catch((error) => {
    if (error instanceof SupportFulfillmentSourceError)
      throw new SupportContentFulfillmentError(error.message)
    throw error
  })
  const proposalSources = new Map(
    sources.map((source) => [
      source.proposalId,
      { id: source.sourceProposalId, requestVersion: source.sourceRequestVersion },
    ]),
  )
  if (proposalSources.size === 0) {
    const identity = {
      contractVersion: 1 as const,
      receipts: [],
      guestRead: { path: 'NOT_APPLICABLE' as const, releaseId: null, nativeStateHash: null },
    }
    return {
      ...identity,
      verifiedAt: asOf.toISOString(),
      digest: supportContentFulfillmentDigest(identity),
    }
  }

  const proposalIds = [...proposalSources.keys()]
  const receiptSelect = {
    id: true,
    proposalId: true,
    moduleId: true,
    revisionId: true,
    module: {
      select: {
        revisions: {
          orderBy: { version: 'desc' as const },
          take: 1,
          select: { id: true, version: true },
        },
        publications: {
          orderBy: { eventOrder: 'desc' as const },
          take: 1,
          select: { id: true, revisionId: true, action: true },
        },
      },
    },
    revision: {
      select: {
        audience: true,
        effectiveFrom: true,
        effectiveUntil: true,
        operationalFact: { select: { expiresAt: true } },
      },
    },
  } as const
  const [universal, adoptions] = await Promise.all([
    client.knowledgeProposalUniversalContentHandoff.findMany({
      where: { tenantId: input.tenantId, venueId: input.venueId, proposalId: { in: proposalIds } },
      orderBy: { id: 'asc' },
      take: MAX_RECEIPTS + 1,
      select: receiptSelect,
    }),
    client.legacyKnowledgeUniversalContentAdoption.findMany({
      where: { tenantId: input.tenantId, venueId: input.venueId, proposalId: { in: proposalIds } },
      orderBy: { id: 'asc' },
      take: MAX_RECEIPTS + 1,
      select: receiptSelect,
    }),
  ])
  if (
    universal.length > MAX_RECEIPTS ||
    adoptions.length > MAX_RECEIPTS ||
    universal.length + adoptions.length > MAX_RECEIPTS
  )
    throw new SupportContentFulfillmentError('Support content receipt count exceeds 100.')

  const receipts: Receipt[] = [
    ...universal.map((receipt) => ({ ...receipt, receiptKind: 'UNIVERSAL' as const })),
    ...adoptions.map((receipt) => ({ ...receipt, receiptKind: 'ADOPTION' as const })),
  ] as Receipt[]
  const receiptProposalIds = new Set(receipts.map(({ proposalId }) => proposalId))
  const verifiedPackageIds = new Set(input.verifiedPackageIds ?? [])
  const verifiedTemporalProposalIds = new Set(input.verifiedTemporalProposalIds ?? [])
  for (const source of sources) {
    if (receiptProposalIds.has(source.proposalId)) continue
    if (source.operationalUpdateHandoffId)
      if (verifiedTemporalProposalIds.has(source.proposalId)) continue
      else
        throw new SupportContentFulfillmentError(
          'A source-bound temporal update remains pending verified fulfillment.',
        )
    if (source.status === 'REJECTED') continue
    if (
      source.packageHandoffVenuePackageId &&
      verifiedPackageIds.has(source.packageHandoffVenuePackageId)
    )
      continue
    throw new SupportContentFulfillmentError(
      'A source-bound proposal has no verified content or package fulfillment.',
    )
  }
  const keys = new Set<string>()
  for (const receipt of receipts) {
    const key = receiptKey(receipt)
    if (keys.has(key))
      throw new SupportContentFulfillmentError(
        'Conflicting universal-content receipts share a proposal target.',
      )
    keys.add(key)
  }
  if (receipts.length === 0) {
    const identity = {
      contractVersion: 1 as const,
      receipts: [],
      guestRead: { path: 'NOT_APPLICABLE' as const, releaseId: null, nativeStateHash: null },
    }
    return {
      ...identity,
      verifiedAt: asOf.toISOString(),
      digest: supportContentFulfillmentDigest(identity),
    }
  }

  const verified = await Promise.all(
    receipts.map(async (receipt) => {
      const source = proposalSources.get(receipt.proposalId)
      if (!source)
        throw new SupportContentFulfillmentError('Content receipt source is out of scope.')
      const publicationId = assertCurrentPublicReceipt(receipt, asOf)
      const projection = await client.venueKnowledgeEntry.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          contentModuleId: receipt.moduleId,
          contentRevisionId: receipt.revisionId,
          contentPublicationId: publicationId,
          isEnabled: true,
          visibility: 'PUBLIC',
        },
        select: {
          id: true,
          title: true,
          category: true,
          content: true,
          sourceType: true,
          sourceName: true,
          sourceUrl: true,
        },
      })
      if (!projection)
        throw new SupportContentFulfillmentError(
          `Content receipt ${receipt.id} has no public projection.`,
        )
      return { receipt, source, publicationId, projection }
    }),
  )
  const snapshot = await resolveNativeGuestReadSnapshotAction({
    client,
    tenantId: input.tenantId,
    venueId: input.venueId,
  })
  const guest = applyNativeGuestContentRead({
    snapshot,
    legacyPlaces: [],
    legacyKnowledgeEntries: verified.map(({ projection }) => ({ ...projection, distance: 0 })),
  })
  const guestById = new Map(guest.knowledgeEntries.map((entry) => [entry.id, entry]))
  const guestRead = {
    path: guest.path,
    releaseId: snapshot.releaseId,
    nativeStateHash: snapshot.state ? nativeCoreVisibleStateHash(snapshot.state) : null,
  }
  const fulfilled = verified
    .map(({ receipt, source, publicationId, projection }) => {
      const observed = guestById.get(projection.id)
      const expectedState = {
        id: projection.id,
        title: projection.title,
        category: projection.category,
        content: projection.content,
        sourceType: projection.sourceType,
        sourceName: projection.sourceName,
        sourceUrl: projection.sourceUrl,
      }
      const observedState = observed
        ? {
            id: observed.id,
            title: observed.title,
            category: observed.category,
            content: observed.content,
            sourceType: observed.sourceType,
            sourceName: observed.sourceName,
            sourceUrl: observed.sourceUrl,
          }
        : null
      if (!observedState || canonicalJson(expectedState) !== canonicalJson(observedState))
        throw new SupportContentFulfillmentError(
          `Content receipt ${receipt.id} is not guest observable in its published projection.`,
        )
      return {
        receiptKind: receipt.receiptKind,
        receiptId: receipt.id,
        proposalId: receipt.proposalId,
        sourceProposalId: source.id,
        sourceRequestVersion: source.requestVersion,
        moduleId: receipt.moduleId,
        revisionId: receipt.revisionId,
        publicationId,
        projectionId: projection.id,
        observedStateHash: createHash('sha256').update(canonicalJson(observedState)).digest('hex'),
      }
    })
    .sort((left, right) => left.receiptId.localeCompare(right.receiptId))
  const identity = { contractVersion: 1 as const, receipts: fulfilled, guestRead }
  return {
    ...identity,
    verifiedAt: asOf.toISOString(),
    digest: supportContentFulfillmentDigest(identity),
  }
}
