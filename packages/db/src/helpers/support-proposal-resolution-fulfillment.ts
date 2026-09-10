import { createHash } from 'node:crypto'

import {
  ContentEvidenceReference,
  SupportCompletionProposalResolutionFulfillment,
} from '@pathfinder/contracts'

import { db } from '../client'
import {
  readSupportFulfillmentSources,
  SupportFulfillmentSourceError,
  type SupportFulfillmentSource,
  type SupportFulfillmentSourceReader,
} from './support-fulfillment-sources'

type TransactionClient = Parameters<Parameters<typeof db.$transaction>[0]>[0]
type Fulfillment = typeof SupportCompletionProposalResolutionFulfillment._type
type Replacement = Omit<Fulfillment['replacements'][number], 'replacementFulfillmentKind'>
type Kind = Fulfillment['replacements'][number]['replacementFulfillmentKind']
export type SupportProposalResolutionReader = Pick<
  TransactionClient,
  '$queryRaw' | 'semanticReviewedDecline' | 'semanticConflictResolution' | 'supportMessage'
> &
  SupportFulfillmentSourceReader

export class SupportProposalResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SupportProposalResolutionError'
  }
}

function fail(message: string): never {
  throw new SupportProposalResolutionError(message)
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function proposalSummary(value: string): string {
  // The action envelope is storage metadata; the review summary remains plain proposal text.
  const body = value.replace(
    /^\[(?:CREATE_KNOWLEDGE|UPDATE_KNOWLEDGE|RETIRE_KNOWLEDGE|RETRIEVAL_CORRECTION|NO_CONTENT_CHANGE)\]\r?\n/u,
    '',
  )
  const characters = Array.from(body)
  return characters.length > 200
    ? `${characters.slice(0, 200).join('')}...`
    : body || 'Proposed change'
}

export type SupportProposalResolutionEvidence = {
  sources: SupportFulfillmentSource[]
  declines: Fulfillment['declines']
  replacements: Replacement[]
  verifiedAt: string
}

/** Caller holds request -> venue locks. This reads decisions, never claims a replacement
 * fulfilled: finalizeSupportProposalResolutionFulfillment must verify that after content reads. */
export async function readSupportProposalResolutionEvidence(
  client: SupportProposalResolutionReader,
  input: { tenantId: string; venueId: string; supportRequestId: string },
): Promise<SupportProposalResolutionEvidence> {
  const readSources = () =>
    readSupportFulfillmentSources(client, input).catch((error) => {
      if (error instanceof SupportFulfillmentSourceError) fail(error.message)
      throw error
    })
  const initialSources = await readSources()
  const ids = initialSources.map(({ proposalId }) => proposalId).sort()
  for (const id of ids)
    await client.$queryRaw`SELECT id FROM knowledge_change_proposals
      WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId} AND id = ${id}::uuid
      FOR SHARE`
  const sources = ids.length ? await readSources() : initialSources
  if (canonical(initialSources) !== canonical(sources))
    fail('Support proposal sources changed while locking.')
  const verifiedAt = new Date().toISOString()
  const result: SupportProposalResolutionEvidence = {
    sources,
    declines: [],
    replacements: [],
    verifiedAt,
  }
  if (!ids.length) return result
  const scoped = { tenantId: input.tenantId, venueId: input.venueId }
  const proposalSelect = {
    id: true,
    status: true,
    updatedAt: true,
    reviewedAt: true,
    reviewerId: true,
    reviewNote: true,
    proposedChange: true,
    evidenceMessageIds: true,
    packageHandoff: { select: { id: true } },
    operationalUpdateHandoff: { select: { id: true } },
    universalContentHandoff: { select: { id: true } },
    legacyContentAdoption: { select: { id: true } },
  } as const
  const [declines, replacements, sourceProposals] = await Promise.all([
    client.semanticReviewedDecline.findMany({
      where: { ...scoped, proposalId: { in: ids } },
      orderBy: { id: 'asc' },
      take: 101,
      include: { proposal: { select: proposalSelect } },
    }),
    client.semanticConflictResolution.findMany({
      where: { ...scoped, proposalId: { in: ids }, outcome: 'PROPOSE_REPLACEMENT' },
      orderBy: { id: 'asc' },
      take: 101,
      include: {
        proposal: { select: proposalSelect },
        question: { select: { status: true, updatedAt: true, answeredAt: true, answer: true } },
      },
    }),
    client.knowledgeChangeProposal.findMany({
      where: {
        ...scoped,
        id: { in: [...new Set(sources.map(({ sourceProposalId }) => sourceProposalId))] },
      },
      select: {
        id: true,
        evidenceMessageIds: true,
        supportRequestId: true,
        supportRequestVersion: true,
      },
      take: 101,
    }),
  ])
  if (declines.length + replacements.length > 100 || sourceProposals.length > 100)
    fail('Support proposal resolution count exceeds 100.')
  const bySource = new Map(sources.map((source) => [source.proposalId, source]))
  const originals = new Map(sourceProposals.map((source) => [source.id, source]))
  const evidenceIds = new Set<string>()
  for (const row of declines) {
    const source = bySource.get(row.proposalId)
    const original = source && originals.get(source.sourceProposalId)
    if (
      !source ||
      !original ||
      row.sourceProposalId !== source.sourceProposalId ||
      row.supportRequestId !== input.supportRequestId ||
      row.supportRequestVersion !== source.sourceRequestVersion ||
      original.supportRequestId !== input.supportRequestId ||
      original.supportRequestVersion !== source.sourceRequestVersion
    )
      fail('Decline source identity is stale.')
    const ids = original.evidenceMessageIds
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 20 ||
      new Set(ids).size !== ids.length
    )
      fail('Decline source evidence IDs are invalid.')
    for (const id of ids) {
      if (typeof id !== 'string' || !id) fail('Decline source evidence IDs are invalid.')
      evidenceIds.add(id)
    }
  }
  const messages = evidenceIds.size
    ? await client.supportMessage.findMany({
        where: {
          ...scoped,
          supportRequestId: input.supportRequestId,
          id: { in: [...evidenceIds] },
        },
        select: { id: true, body: true, createdAt: true, requestVersion: true },
        take: 2001,
      })
    : []
  const byMessage = new Map(messages.map((message) => [message.id, message]))
  const resolvedIds = new Set<string>()
  for (const row of declines) {
    if (resolvedIds.has(row.proposalId)) fail('A proposal has conflicting reviewed outcomes.')
    resolvedIds.add(row.proposalId)
    const proposal = row.proposal
    if (
      proposal.status !== 'REJECTED' ||
      proposal.updatedAt.getTime() !== row.reviewedProposalUpdatedAt.getTime() ||
      proposal.reviewedAt?.getTime() !== row.reviewedAt.getTime() ||
      proposal.reviewerId !== row.createdBy ||
      proposal.reviewNote === null ||
      hash(proposal.reviewNote) !== row.reviewNoteHash ||
      proposal.packageHandoff ||
      proposal.operationalUpdateHandoff ||
      proposal.universalContentHandoff ||
      proposal.legacyContentAdoption
    )
      fail('Reviewed-decline proposal state is stale or has competing content.')
    const source = bySource.get(row.proposalId)!
    const original = originals.get(source.sourceProposalId)!
    const expected = (original.evidenceMessageIds as string[]).map((id) => {
      const message = byMessage.get(id)
      if (
        !message ||
        message.requestVersion === null ||
        message.requestVersion > source.sourceRequestVersion
      )
        fail('Reviewed-decline source message is unavailable.')
      return {
        sourceId: `support-message:${message.id}`,
        locator: `support-request:${input.supportRequestId}`,
        capturedAt: message.createdAt.toISOString(),
        excerptHash: hash(message.body),
      }
    })
    const parsed = ContentEvidenceReference.array().min(1).max(20).safeParse(row.sourceEvidence)
    if (!parsed.success || canonical(parsed.data) !== canonical(expected))
      fail('Reviewed-decline source evidence changed.')
    result.declines.push({
      resolutionId: row.id,
      proposalId: row.proposalId,
      sourceProposalId: source.sourceProposalId,
      sourceRequestVersion: source.sourceRequestVersion,
      replacementOfProposalId: source.replacementOfProposalId,
      proposalUpdatedAt: row.proposalUpdatedAt.toISOString(),
      reviewedProposalUpdatedAt: row.reviewedProposalUpdatedAt.toISOString(),
      reviewedAt: row.reviewedAt.toISOString(),
      reviewNoteHash: row.reviewNoteHash,
      reviewNote: proposal.reviewNote,
      proposalSummary: proposalSummary(proposal.proposedChange),
      sourceEvidenceHash: hash(canonical(parsed.data)),
      createdBy: row.createdBy,
      decisionCreatedAt: row.createdAt.toISOString(),
    })
  }
  const replacementIds = new Set<string>()
  for (const row of replacements) {
    const source = bySource.get(row.proposalId)
    const replacement = row.replacementProposalId && bySource.get(row.replacementProposalId)
    if (
      !source ||
      !replacement ||
      resolvedIds.has(row.proposalId) ||
      replacementIds.has(replacement.proposalId) ||
      source.sourceProposalId !== row.proposalId ||
      source.replacementOfProposalId !== null ||
      replacement.replacementOfProposalId !== row.proposalId ||
      replacement.sourceProposalId !== row.proposalId ||
      replacement.sourceRequestVersion !== source.sourceRequestVersion
    )
      fail('Retired proposal replacement lineage is inconsistent.')
    resolvedIds.add(row.proposalId)
    replacementIds.add(replacement.proposalId)
    const proposal = row.proposal
    if (
      proposal.status !== 'REJECTED' ||
      proposal.reviewerId !== row.createdBy ||
      proposal.reviewNote !== `Resolved by semantic conflict decision ${row.id}.` ||
      proposal.packageHandoff ||
      proposal.operationalUpdateHandoff ||
      proposal.universalContentHandoff ||
      proposal.legacyContentAdoption ||
      row.question.status !== 'ANSWERED' ||
      row.question.updatedAt.getTime() !== row.questionUpdatedAt.getTime() ||
      row.question.answeredAt?.getTime() !== row.answeredAt.getTime() ||
      row.question.answer === null ||
      hash(row.question.answer) !== row.answerHash
    )
      fail('Retired proposal decision evidence is stale.')
    result.replacements.push({
      resolutionId: row.id,
      proposalId: row.proposalId,
      sourceRequestVersion: source.sourceRequestVersion,
      replacementProposalId: replacement.proposalId,
      proposalUpdatedAt: proposal.updatedAt.toISOString(),
      decisionProposalUpdatedAt: row.proposalUpdatedAt.toISOString(),
      questionId: row.questionId,
      questionUpdatedAt: row.questionUpdatedAt.toISOString(),
      answeredAt: row.answeredAt.toISOString(),
      answerHash: row.answerHash,
      createdBy: row.createdBy,
      decisionCreatedAt: row.createdAt.toISOString(),
    })
  }
  return result
}

/** Finalize only after every corresponding content/package/no-change read succeeded. */
export function finalizeSupportProposalResolutionFulfillment(
  evidence: SupportProposalResolutionEvidence,
  verified: Array<{ proposalId: string; kind: Kind }>,
): Fulfillment {
  const relevantIds = new Set([
    ...evidence.declines.map(({ proposalId }) => proposalId),
    ...evidence.replacements.map(({ replacementProposalId }) => replacementProposalId),
  ])
  const byProposal = new Map<string, Kind>()
  for (const { proposalId, kind } of verified) {
    // These decisions do not impose new exclusivity on unrelated historical receipts.
    if (!relevantIds.has(proposalId)) continue
    if (byProposal.has(proposalId) && byProposal.get(proposalId) !== kind)
      fail('Replacement has competing fulfillment kinds.')
    byProposal.set(proposalId, kind)
  }
  for (const decline of evidence.declines) {
    if (byProposal.has(decline.proposalId)) fail('Declined proposal also has verified content.')
    byProposal.set(decline.proposalId, 'DECLINE')
  }
  const replacements = evidence.replacements.map((row) => {
    const kind = byProposal.get(row.replacementProposalId)
    if (!kind) fail('Retired proposal replacement has no verified fulfillment.')
    return { ...row, replacementFulfillmentKind: kind }
  })
  const identity = { contractVersion: 1 as const, declines: evidence.declines, replacements }
  return SupportCompletionProposalResolutionFulfillment.parse({
    ...identity,
    verifiedAt: evidence.verifiedAt,
    digest: hash(canonical(identity)),
  })
}
