import { createHash } from 'node:crypto'

import type { TRPCContext } from '../context'
import {
  buildSemanticVenueUpdate,
  type CurrentVenueKnowledge,
  type SemanticUpdaterInput,
} from './semantic-venue-updater'

export class SemanticVenueUpdaterError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'STALE' | 'NOT_REVIEWABLE',
    message: string,
  ) {
    super(message)
    this.name = 'SemanticVenueUpdaterError'
  }
}

export type SemanticVenueUpdatePreviewParameters = Pick<
  SemanticUpdaterInput,
  'relation' | 'desired' | 'validFrom' | 'validUntil' | 'operationalUpdateType'
> & {
  tenantId: string
  venueId: string
  proposalId: string
  expectedUpdatedAt: Date
}

type PreviewInput = SemanticVenueUpdatePreviewParameters & { db: TRPCContext['db'] }

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function semanticVenueUpdateDraftKey(
  input: Pick<SemanticVenueUpdatePreviewParameters, 'tenantId' | 'venueId' | 'proposalId'> & {
    previewHash: string
  },
) {
  return deterministicUuid(
    `pathfinder:semantic-venue-update-draft:v1:${input.tenantId}:${input.venueId}:${input.proposalId}:${input.previewHash}`,
  )
}

function currentAuthority(entry: {
  humanConfirmedAt: Date | null
  authorship: string
  sourceType: string
}): CurrentVenueKnowledge['authority'] {
  if (entry.humanConfirmedAt) return 'VENUE_CONFIRMED'
  if (entry.authorship === 'HUMAN_AUTHORED' && entry.sourceType === 'PATHFINDER_INTAKE') {
    return 'OFFICIAL_VENUE_SOURCE'
  }
  if (entry.sourceType !== 'UNKNOWN') return 'PUBLIC_SECONDARY'
  return 'UNVERIFIED'
}

export async function previewSemanticVenueUpdateFromProposal(input: PreviewInput) {
  const proposal = await input.db.knowledgeChangeProposal.findFirst({
    where: {
      id: input.proposalId,
      tenantId: input.tenantId,
      venueId: input.venueId,
    },
    select: {
      id: true,
      status: true,
      targetKnowledgeEntryId: true,
      proposedChange: true,
      reason: true,
      confidence: true,
      evidenceMessageIds: true,
      createdByType: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  if (!proposal) throw new SemanticVenueUpdaterError('NOT_FOUND', 'Knowledge proposal not found.')
  if (proposal.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
    throw new SemanticVenueUpdaterError('STALE', 'Knowledge proposal changed; reload its evidence.')
  }
  if (!['PENDING_REVIEW', 'APPROVED'].includes(proposal.status)) {
    throw new SemanticVenueUpdaterError(
      'NOT_REVIEWABLE',
      'Only pending-review or approved knowledge proposals can be previewed.',
    )
  }

  const current = await input.db.venueKnowledgeEntry.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      OR: [
        ...(proposal.targetKnowledgeEntryId ? [{ id: proposal.targetKnowledgeEntryId }] : []),
        {
          title: { equals: input.desired.title, mode: 'insensitive' },
          category: { equals: input.desired.category, mode: 'insensitive' },
        },
      ],
    },
    select: {
      id: true,
      title: true,
      category: true,
      content: true,
      isEnabled: true,
      humanConfirmedAt: true,
      authorship: true,
      sourceType: true,
    },
  })
  const normalizedHash = createHash('sha256')
    .update(
      JSON.stringify({
        proposalId: proposal.id,
        proposedChange: proposal.proposedChange,
        reason: proposal.reason,
        evidenceMessageIds: proposal.evidenceMessageIds,
        updatedAt: proposal.updatedAt.toISOString(),
      }),
    )
    .digest('hex')
  const classification = buildSemanticVenueUpdate(
    {
      venueId: input.venueId,
      relation: input.relation,
      ...(proposal.targetKnowledgeEntryId
        ? { targetKnowledgeEntryId: proposal.targetKnowledgeEntryId }
        : {}),
      desired: input.desired,
      contentOrigin: proposal.createdByType === 'HUMAN' ? 'HUMAN_AUTHORED' : 'AI_GENERATED',
      evidenceReview: proposal.status === 'APPROVED' ? 'HUMAN_REVIEWED' : 'UNREVIEWED',
      evidence: [
        {
          id: `knowledge-proposal:${proposal.id}`,
          sourceType: 'KNOWLEDGE_PROPOSAL',
          authority: proposal.status === 'APPROVED' ? 'TRUSTED_PARTNER' : 'UNVERIFIED',
          confidence: Number(proposal.confidence),
          normalizedHash,
          retrievedAt: proposal.createdAt.toISOString(),
          sourceName: `${proposal.status.toLowerCase().replaceAll('_', ' ')} knowledge proposal`,
        },
      ],
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
      ...(input.validUntil ? { validUntil: input.validUntil } : {}),
      ...(input.operationalUpdateType
        ? { operationalUpdateType: input.operationalUpdateType }
        : {}),
    },
    current.map((entry) => ({
      id: entry.id,
      title: entry.title,
      category: entry.category,
      content: entry.content,
      isEnabled: entry.isEnabled,
      authority: currentAuthority(entry),
    })),
  )

  const messageIds = Array.isArray(proposal.evidenceMessageIds)
    ? proposal.evidenceMessageIds.filter((value): value is string => typeof value === 'string')
    : []
  return {
    proposalId: proposal.id,
    proposalStatus: proposal.status,
    proposalUpdatedAt: proposal.updatedAt,
    proposalEvidenceRefs: messageIds.map((id) => `guest-message:${id}`),
    ...classification,
  }
}
