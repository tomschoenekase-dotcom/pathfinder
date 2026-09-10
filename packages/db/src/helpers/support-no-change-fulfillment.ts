import { createHash } from 'node:crypto'

import {
  hashSemanticCanonicalKnowledgeTarget,
  nativeCoreVisibleStateHash,
  ContentEvidenceReference,
} from '@pathfinder/contracts'

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

export type SupportNoChangeFulfillment = {
  contractVersion: 1
  receipts: Array<{
    outcome: 'DUPLICATE_NOOP' | 'KEEP_CANONICAL'
    resolutionId: string
    proposalId: string
    sourceProposalId: string
    sourceRequestVersion: number
    replacementOfProposalId: string | null
    proposalUpdatedAt: string
    targetKnowledgeEntryId: string
    targetSnapshotHash: string
    observedStateHash: string
    decisionCreatedAt: string
    contentModuleId: string | null
    contentRevisionId: string | null
    contentPublicationId: string | null
    effectiveFrom: string | null
    effectiveUntil: string | null
    operationalFactExpiresAt: string | null
  }>
  guestRead: {
    path: NativeGuestReadPath | 'NOT_APPLICABLE'
    releaseId: string | null
    nativeStateHash: string | null
  }
  verifiedAt: string
  digest: string
}

export type SupportNoChangeFulfillmentReader = Pick<
  TransactionClient,
  | '$queryRaw'
  | 'semanticDuplicateResolution'
  | 'semanticConflictResolution'
  | 'venueKnowledgeEntry'
  | 'tenantFeatureFlag'
  | 'nativeVenueDeploymentHead'
  | 'nativeVenueDeploymentEvaluationEvidence'
  | 'supportMessage'
> &
  SupportFulfillmentSourceReader

const MAX_RECEIPTS = 100

export class SupportNoChangeFulfillmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SupportNoChangeFulfillmentError'
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

export function supportNoChangeFulfillmentDigest(
  value: Omit<SupportNoChangeFulfillment, 'verifiedAt' | 'digest'>,
): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

type ReceiptRow = {
  outcome: 'DUPLICATE_NOOP' | 'KEEP_CANONICAL'
  id: string
  proposalId: string
  proposalUpdatedAt: Date
  targetKnowledgeEntryId: string
  targetSnapshotHash: string
  createdAt: Date
  createdBy: string
  sourceEvidence?: unknown
  proposal: {
    status: string
    updatedAt: Date
    reviewerId: string | null
    reviewNote: string | null
    supportRequestId: string | null
    supportRequestVersion: number | null
    evidenceMessageIds: unknown
    packageHandoff: { proposalId: string } | null
    operationalUpdateHandoff: { id: string } | null
    universalContentHandoff: { id: string } | null
    legacyContentAdoption: { id: string } | null
  }
}

/** Caller must already hold the support-request and venue locks, in that order. */
export async function readSupportNoChangeFulfillment(
  client: SupportNoChangeFulfillmentReader,
  input: { tenantId: string; venueId: string; supportRequestId: string; asOf?: Date },
): Promise<SupportNoChangeFulfillment> {
  const sources = await readSupportFulfillmentSources(client, input).catch((error) => {
    if (error instanceof SupportFulfillmentSourceError)
      throw new SupportNoChangeFulfillmentError(error.message)
    throw error
  })
  const sourceByProposal = new Map(sources.map((source) => [source.proposalId, source]))
  const proposalIds = [...sourceByProposal.keys()]
  if (proposalIds.length === 0) {
    const asOf = input.asOf ?? new Date()
    if (!Number.isFinite(asOf.getTime()))
      throw new SupportNoChangeFulfillmentError('Invalid verification time.')
    const identity = {
      contractVersion: 1 as const,
      receipts: [],
      guestRead: { path: 'NOT_APPLICABLE' as const, releaseId: null, nativeStateHash: null },
    }
    return {
      ...identity,
      verifiedAt: asOf.toISOString(),
      digest: supportNoChangeFulfillmentDigest(identity),
    }
  }
  for (const proposalId of [...proposalIds].sort())
    await client.$queryRaw`SELECT id FROM knowledge_change_proposals
      WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId} AND id = ${proposalId}::uuid
      FOR SHARE`
  const proposalSelect = {
    status: true,
    updatedAt: true,
    reviewerId: true,
    reviewNote: true,
    supportRequestId: true,
    supportRequestVersion: true,
    evidenceMessageIds: true,
    packageHandoff: { select: { proposalId: true } },
    operationalUpdateHandoff: { select: { id: true } },
    universalContentHandoff: { select: { id: true } },
    legacyContentAdoption: { select: { id: true } },
  } as const
  const [duplicates, keepCanonical] = (await Promise.all([
    client.semanticDuplicateResolution.findMany({
      where: { tenantId: input.tenantId, venueId: input.venueId, proposalId: { in: proposalIds } },
      orderBy: { id: 'asc' },
      take: MAX_RECEIPTS + 1,
      select: {
        id: true,
        proposalId: true,
        proposalUpdatedAt: true,
        targetKnowledgeEntryId: true,
        targetSnapshotHash: true,
        createdAt: true,
        createdBy: true,
        sourceEvidence: true,
        proposal: { select: proposalSelect },
      },
    }),
    client.semanticConflictResolution.findMany({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: { in: proposalIds },
        outcome: 'KEEP_CANONICAL',
      },
      orderBy: { id: 'asc' },
      take: MAX_RECEIPTS + 1,
      select: {
        id: true,
        proposalId: true,
        proposalUpdatedAt: true,
        targetKnowledgeEntryId: true,
        targetSnapshotHash: true,
        createdAt: true,
        createdBy: true,
        proposal: { select: proposalSelect },
        question: {
          select: {
            status: true,
            updatedAt: true,
            answeredAt: true,
            answer: true,
          },
        },
        questionUpdatedAt: true,
        answeredAt: true,
        answerHash: true,
      },
    }),
  ])) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>]
  if (duplicates.length > MAX_RECEIPTS || keepCanonical.length > MAX_RECEIPTS)
    throw new SupportNoChangeFulfillmentError('No-change receipt count exceeds 100.')
  const duplicateRows = duplicates.map((row) => ({ ...row, outcome: 'DUPLICATE_NOOP' }))
  const keepRows = keepCanonical.map((row) => ({ ...row, outcome: 'KEEP_CANONICAL' }))
  if (duplicateRows.length + keepRows.length > MAX_RECEIPTS)
    throw new SupportNoChangeFulfillmentError('No-change receipt count exceeds 100.')
  const rows = [...duplicateRows, ...keepRows] as unknown as ReceiptRow[]
  if (rows.length === 0) {
    const asOf = input.asOf ?? new Date()
    if (!Number.isFinite(asOf.getTime()))
      throw new SupportNoChangeFulfillmentError('Invalid verification time.')
    const identity = {
      contractVersion: 1 as const,
      receipts: [],
      guestRead: { path: 'NOT_APPLICABLE' as const, releaseId: null, nativeStateHash: null },
    }
    return {
      ...identity,
      verifiedAt: asOf.toISOString(),
      digest: supportNoChangeFulfillmentDigest(identity),
    }
  }
  const proposalReceiptIds = new Set<string>()
  for (const row of rows) {
    if (proposalReceiptIds.has(row.proposalId))
      throw new SupportNoChangeFulfillmentError('A proposal has conflicting no-change outcomes.')
    proposalReceiptIds.add(row.proposalId)
    if (
      row.proposal.packageHandoff ||
      row.proposal.operationalUpdateHandoff ||
      row.proposal.universalContentHandoff ||
      row.proposal.legacyContentAdoption
    )
      throw new SupportNoChangeFulfillmentError(
        'A no-change proposal also has a mutating fulfillment receipt.',
      )
    if (
      row.outcome === 'DUPLICATE_NOOP' &&
      (row.proposal.status !== 'APPROVED' ||
        row.proposal.updatedAt.getTime() !== row.proposalUpdatedAt.getTime())
    )
      throw new SupportNoChangeFulfillmentError('Duplicate receipt proposal is not approved.')
    if (row.outcome === 'KEEP_CANONICAL') {
      const conflict = row as ReceiptRow & {
        questionUpdatedAt: Date
        answeredAt: Date
        answerHash: string
        question: {
          status: string
          updatedAt: Date
          answeredAt: Date | null
          answer: string | null
        }
      }
      if (
        row.proposal.status !== 'REJECTED' ||
        row.proposal.reviewerId !== row.createdBy ||
        row.proposal.reviewNote !== `Resolved by semantic conflict decision ${row.id}.` ||
        conflict.question.status !== 'ANSWERED' ||
        conflict.question.updatedAt.getTime() !== conflict.questionUpdatedAt.getTime() ||
        conflict.question.answeredAt?.getTime() !== conflict.answeredAt.getTime() ||
        conflict.question.answer === null ||
        createHash('sha256').update(conflict.question.answer).digest('hex') !== conflict.answerHash
      )
        throw new SupportNoChangeFulfillmentError('Keep-canonical decision evidence is stale.')
    }
  }
  const duplicateEvidence = duplicateRows as unknown as ReceiptRow[]
  const evidenceIds = new Set<string>()
  for (const row of duplicateEvidence) {
    if (
      !Array.isArray(row.proposal.evidenceMessageIds) ||
      row.proposal.evidenceMessageIds.length < 1 ||
      row.proposal.evidenceMessageIds.length > 20 ||
      new Set(row.proposal.evidenceMessageIds).size !== row.proposal.evidenceMessageIds.length
    )
      throw new SupportNoChangeFulfillmentError('Duplicate source evidence IDs are invalid.')
    for (const id of row.proposal.evidenceMessageIds) {
      if (typeof id !== 'string' || !id) {
        throw new SupportNoChangeFulfillmentError('Duplicate source evidence IDs are invalid.')
      }
      evidenceIds.add(id)
    }
  }
  const evidenceMessages = await client.supportMessage.findMany({
    where: {
      id: { in: [...evidenceIds] },
      tenantId: input.tenantId,
      venueId: input.venueId,
      supportRequestId: input.supportRequestId,
    },
    select: { id: true, body: true, createdAt: true, requestVersion: true },
  })
  const evidenceById = new Map(evidenceMessages.map((message) => [message.id, message]))
  for (const row of duplicateEvidence) {
    const ids = row.proposal.evidenceMessageIds as string[]
    const parsed = ContentEvidenceReference.array().min(1).max(20).safeParse(row.sourceEvidence)
    if (!parsed.success || parsed.data.length !== ids.length)
      throw new SupportNoChangeFulfillmentError('Duplicate source evidence is stale.')
    const expected = ids.map((id) => {
      const message = evidenceById.get(id)
      const source = sourceByProposal.get(row.proposalId)
      if (
        !source ||
        !message ||
        message.requestVersion === null ||
        message.requestVersion > source.sourceRequestVersion
      )
        throw new SupportNoChangeFulfillmentError('Duplicate source evidence is stale.')
      return {
        sourceId: `support-message:${message.id}`,
        locator: `support-request:${input.supportRequestId}`,
        capturedAt: message.createdAt.toISOString(),
        excerptHash: createHash('sha256').update(message.body).digest('hex'),
      }
    })
    if (canonicalJson(parsed.data) !== canonicalJson(expected))
      throw new SupportNoChangeFulfillmentError('Duplicate source evidence is stale.')
  }

  const targetIds = [...new Set(rows.map((row) => row.targetKnowledgeEntryId))].sort()
  for (const targetId of targetIds)
    await client.$queryRaw`SELECT id FROM venue_knowledge_entries
      WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId} AND id = ${targetId}
      FOR SHARE`
  const asOf = input.asOf ?? new Date()
  if (!Number.isFinite(asOf.getTime()))
    throw new SupportNoChangeFulfillmentError('Invalid verification time.')

  const targets = await client.venueKnowledgeEntry.findMany({
    where: { tenantId: input.tenantId, venueId: input.venueId, id: { in: targetIds } },
    select: {
      id: true,
      title: true,
      category: true,
      content: true,
      isEnabled: true,
      visibility: true,
      humanConfirmedAt: true,
      authorship: true,
      sourceType: true,
      sourceName: true,
      sourceUrl: true,
      contentModuleId: true,
      contentRevisionId: true,
      contentPublicationId: true,
      contentModule: {
        select: {
          revisions: { orderBy: { version: 'desc' }, take: 1, select: { id: true } },
          publications: {
            orderBy: { eventOrder: 'desc' },
            take: 1,
            select: { id: true, revisionId: true, action: true },
          },
        },
      },
      contentRevision: {
        select: {
          audience: true,
          effectiveFrom: true,
          effectiveUntil: true,
          operationalFact: { select: { expiresAt: true } },
        },
      },
    },
  })
  const targetById = new Map(targets.map((target) => [target.id, target]))
  const snapshot = await resolveNativeGuestReadSnapshotAction({
    client,
    tenantId: input.tenantId,
    venueId: input.venueId,
  })
  const guest = applyNativeGuestContentRead({
    snapshot,
    legacyPlaces: [],
    legacyKnowledgeEntries: targets.map((target) => ({ ...target, distance: 0 })),
  })
  const guestById = new Map(guest.knowledgeEntries.map((entry) => [entry.id, entry]))
  const fulfilled = rows.map((row) => {
    const source = sourceByProposal.get(row.proposalId)
    const target = targetById.get(row.targetKnowledgeEntryId)
    const observed = guestById.get(row.targetKnowledgeEntryId)
    if (!source || !target || !target.isEnabled || target.visibility !== 'PUBLIC')
      throw new SupportNoChangeFulfillmentError('No-change target is not currently public.')
    if (
      hashSemanticCanonicalKnowledgeTarget({
        id: target.id,
        title: target.title,
        category: target.category,
        content: target.content,
        isEnabled: target.isEnabled,
        humanConfirmedAt: target.humanConfirmedAt,
        authorship: target.authorship,
        sourceType: target.sourceType,
      }) !== row.targetSnapshotHash
    )
      throw new SupportNoChangeFulfillmentError('No-change target snapshot changed.')
    const links = [target.contentModuleId, target.contentRevisionId, target.contentPublicationId]
    if (links.some(Boolean) && links.some((link) => !link))
      throw new SupportNoChangeFulfillmentError('No-change target has partial native links.')
    const revision = target.contentRevision
    if (target.contentModuleId) {
      const latestRevision = target.contentModule?.revisions[0]
      const latestPublication = target.contentModule?.publications[0]
      if (
        !revision ||
        latestRevision?.id !== target.contentRevisionId ||
        latestPublication?.id !== target.contentPublicationId ||
        latestPublication.action !== 'PUBLISH' ||
        latestPublication.revisionId !== target.contentRevisionId ||
        revision.audience !== 'PUBLIC' ||
        (revision.effectiveFrom && revision.effectiveFrom > asOf) ||
        (revision.effectiveUntil && revision.effectiveUntil <= asOf) ||
        (revision.operationalFact?.expiresAt && revision.operationalFact.expiresAt <= asOf)
      )
        throw new SupportNoChangeFulfillmentError(
          'No-change target native publication is stale or ineffective.',
        )
    }
    const expected = {
      id: target.id,
      title: target.title,
      category: target.category,
      content: target.content,
      sourceType: target.sourceType,
      sourceName: target.sourceName,
      sourceUrl: target.sourceUrl,
    }
    const observedValue = observed
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
    if (!observedValue || canonicalJson(expected) !== canonicalJson(observedValue))
      throw new SupportNoChangeFulfillmentError('No-change target is not guest observable.')
    return {
      outcome: row.outcome,
      resolutionId: row.id,
      proposalId: row.proposalId,
      sourceProposalId: source.sourceProposalId,
      sourceRequestVersion: source.sourceRequestVersion,
      replacementOfProposalId: source.replacementOfProposalId,
      proposalUpdatedAt: row.proposal.updatedAt.toISOString(),
      targetKnowledgeEntryId: row.targetKnowledgeEntryId,
      targetSnapshotHash: row.targetSnapshotHash,
      observedStateHash: createHash('sha256').update(canonicalJson(observedValue)).digest('hex'),
      decisionCreatedAt: row.createdAt.toISOString(),
      contentModuleId: target.contentModuleId,
      contentRevisionId: target.contentRevisionId,
      contentPublicationId: target.contentPublicationId,
      effectiveFrom: revision?.effectiveFrom?.toISOString() ?? null,
      effectiveUntil: revision?.effectiveUntil?.toISOString() ?? null,
      operationalFactExpiresAt: revision?.operationalFact?.expiresAt?.toISOString() ?? null,
    }
  })
  fulfilled.sort((left, right) => left.resolutionId.localeCompare(right.resolutionId))
  const identity = {
    contractVersion: 1 as const,
    receipts: fulfilled,
    guestRead: {
      path: guest.path,
      releaseId: snapshot.releaseId,
      nativeStateHash: snapshot.state ? nativeCoreVisibleStateHash(snapshot.state) : null,
    },
  }
  return {
    ...identity,
    verifiedAt: asOf.toISOString(),
    digest: supportNoChangeFulfillmentDigest(identity),
  }
}
