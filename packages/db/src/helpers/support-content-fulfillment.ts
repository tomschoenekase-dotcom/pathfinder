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
import {
  resolveSupportContentReceiptChains,
  SupportContentChainError,
  type SupportContentChainReceipt,
} from './support-content-fulfillment-chain'

type TransactionClient = Parameters<Parameters<typeof db.$transaction>[0]>[0]

export type SupportContentFulfillment = {
  contractVersion: 2
  receipts: Array<
    {
      receiptKind: 'UNIVERSAL' | 'ADOPTION'
      receiptId: string
      proposalId: string
      sourceProposalId: string
      sourceRequestVersion: number
      replacementOfProposalId: string | null
      moduleId: string
      moduleKind: 'ITEM' | 'SERVICE' | 'POLICY' | 'EVENT' | 'OPERATIONAL_FACT' | 'RELATIONSHIP'
      revisionId: string
      revisionVersion: number
      effectiveFrom: string | null
      effectiveUntil: string | null
      operationalFactExpiresAt: string | null
      classification: string | null
      relation: string | null
      expectedBaseRevisionId: string | null
      expectedBaseVersion: number | null
    } & (
      | {
          state: 'CURRENT'
          supersededByReceiptId: null
          publicationId: string
          projectionId: string
          observedStateHash: string
        }
      | {
          state: 'SUPERSEDED'
          supersededByReceiptId: string
          publicationId: null
          projectionId: null
          observedStateHash: null
        }
    )
  >
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
  moduleKind: 'ITEM' | 'SERVICE' | 'POLICY' | 'EVENT' | 'OPERATIONAL_FACT' | 'RELATIONSHIP'
  revisionId: string
  classification: string | null
  relation: string | null
  expectedBaseRevisionId: string | null
  expectedBaseVersion: number | null
  module: {
    revisions: Array<{ id: string; version: number }>
    publications: Array<{ id: string; revisionId: string; action: 'PUBLISH' | 'WITHDRAW' }>
  }
  revision: {
    version: number
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
    verifiedNoChangeProposalIds?: string[]
    verifiedReviewedDeclineProposalIds?: string[]
    verifiedReplacementOriginalProposalIds?: string[]
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
      contractVersion: 2 as const,
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
    moduleKind: true,
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
        version: true,
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
      select: {
        ...receiptSelect,
        classification: true,
        relation: true,
        expectedBaseRevisionId: true,
        expectedBaseVersion: true,
      },
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
    ...adoptions.map((receipt) => ({
      ...receipt,
      receiptKind: 'ADOPTION' as const,
      classification: null,
      relation: null,
      expectedBaseRevisionId: null,
      expectedBaseVersion: null,
    })),
  ] as Receipt[]
  const receiptProposalIds = new Set(receipts.map(({ proposalId }) => proposalId))
  const verifiedPackageIds = new Set(input.verifiedPackageIds ?? [])
  const verifiedTemporalProposalIds = new Set(input.verifiedTemporalProposalIds ?? [])
  const verifiedNoChangeProposalIds = new Set(input.verifiedNoChangeProposalIds ?? [])
  const reviewedDeclines = new Set(input.verifiedReviewedDeclineProposalIds ?? [])
  const replacedOriginals = new Set(input.verifiedReplacementOriginalProposalIds ?? [])
  for (const source of sources) {
    if (receiptProposalIds.has(source.proposalId)) continue
    if (source.operationalUpdateHandoffId)
      if (verifiedTemporalProposalIds.has(source.proposalId)) continue
      else
        throw new SupportContentFulfillmentError(
          'A source-bound temporal update remains pending verified fulfillment.',
        )
    if (verifiedNoChangeProposalIds.has(source.proposalId)) continue
    if (reviewedDeclines.has(source.proposalId) || replacedOriginals.has(source.proposalId))
      continue
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
      contractVersion: 2 as const,
      receipts: [],
      guestRead: { path: 'NOT_APPLICABLE' as const, releaseId: null, nativeStateHash: null },
    }
    return {
      ...identity,
      verifiedAt: asOf.toISOString(),
      digest: supportContentFulfillmentDigest(identity),
    }
  }

  const sourceByProposal = new Map(sources.map((source) => [source.proposalId, source]))
  const chainReceipts: SupportContentChainReceipt[] = receipts.map((receipt) => {
    const source = sourceByProposal.get(receipt.proposalId)
    if (!source) throw new SupportContentFulfillmentError('Content receipt source is out of scope.')
    return {
      receiptId: receipt.id,
      receiptKind: receipt.receiptKind,
      proposalId: receipt.proposalId,
      sourceProposalId: source.sourceProposalId,
      sourceRequestVersion: source.sourceRequestVersion,
      replacementOfProposalId: source.replacementOfProposalId,
      moduleId: receipt.moduleId,
      moduleKind: receipt.moduleKind,
      revisionId: receipt.revisionId,
      revisionVersion: receipt.revision.version,
      classification: receipt.classification,
      relation: receipt.relation,
      expectedBaseRevisionId: receipt.expectedBaseRevisionId,
      expectedBaseVersion: receipt.expectedBaseVersion,
    }
  })
  const successors = (() => {
    try {
      return resolveSupportContentReceiptChains(chainReceipts)
    } catch (error) {
      if (error instanceof SupportContentChainError)
        throw new SupportContentFulfillmentError(error.message)
      throw error
    }
  })()
  const terminalReceipts = receipts.filter((receipt) => !successors.has(receipt.id))
  const verified = await Promise.all(
    terminalReceipts.map(async (receipt) => {
      const source = sourceByProposal.get(receipt.proposalId)
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
  const verifiedByReceiptId = new Map(verified.map((item) => [item.receipt.id, item]))
  const fulfilled: SupportContentFulfillment['receipts'] = receipts
    .map((receipt) => {
      const source = sourceByProposal.get(receipt.proposalId)
      if (!source)
        throw new SupportContentFulfillmentError('Content receipt source is out of scope.')
      const successorId = successors.get(receipt.id) ?? null
      const verifiedReceipt = verifiedByReceiptId.get(receipt.id)
      if (!verifiedReceipt) {
        if (!successorId)
          throw new SupportContentFulfillmentError('Content receipt chain has no current terminal.')
        return {
          receiptKind: receipt.receiptKind,
          receiptId: receipt.id,
          proposalId: receipt.proposalId,
          sourceProposalId: source.sourceProposalId,
          sourceRequestVersion: source.sourceRequestVersion,
          replacementOfProposalId: source.replacementOfProposalId,
          moduleId: receipt.moduleId,
          moduleKind: receipt.moduleKind,
          revisionId: receipt.revisionId,
          revisionVersion: receipt.revision.version,
          effectiveFrom: receipt.revision.effectiveFrom?.toISOString() ?? null,
          effectiveUntil: receipt.revision.effectiveUntil?.toISOString() ?? null,
          operationalFactExpiresAt:
            receipt.revision.operationalFact?.expiresAt?.toISOString() ?? null,
          classification: receipt.classification,
          relation: receipt.relation,
          expectedBaseRevisionId: receipt.expectedBaseRevisionId,
          expectedBaseVersion: receipt.expectedBaseVersion,
          state: 'SUPERSEDED' as const,
          supersededByReceiptId: successorId,
          publicationId: null,
          projectionId: null,
          observedStateHash: null,
        }
      }
      const { publicationId, projection } = verifiedReceipt
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
        sourceProposalId: source.sourceProposalId,
        sourceRequestVersion: source.sourceRequestVersion,
        replacementOfProposalId: source.replacementOfProposalId,
        moduleId: receipt.moduleId,
        moduleKind: receipt.moduleKind,
        revisionId: receipt.revisionId,
        revisionVersion: receipt.revision.version,
        effectiveFrom: receipt.revision.effectiveFrom?.toISOString() ?? null,
        effectiveUntil: receipt.revision.effectiveUntil?.toISOString() ?? null,
        operationalFactExpiresAt:
          receipt.revision.operationalFact?.expiresAt?.toISOString() ?? null,
        classification: receipt.classification,
        relation: receipt.relation,
        expectedBaseRevisionId: receipt.expectedBaseRevisionId,
        expectedBaseVersion: receipt.expectedBaseVersion,
        state: 'CURRENT' as const,
        supersededByReceiptId: null,
        publicationId,
        projectionId: projection.id,
        observedStateHash: createHash('sha256').update(canonicalJson(observedState)).digest('hex'),
      }
    })
    .sort((left, right) => left.receiptId.localeCompare(right.receiptId))
  const identity = { contractVersion: 2 as const, receipts: fulfilled, guestRead }
  return {
    ...identity,
    verifiedAt: asOf.toISOString(),
    digest: supportContentFulfillmentDigest(identity),
  }
}
