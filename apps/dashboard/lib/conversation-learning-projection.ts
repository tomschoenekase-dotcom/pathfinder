import type { ConversationLearningCandidate } from '../components/admin/ConversationLearningReview'

function readProvenance(value: unknown): ConversationLearningCandidate['candidateProvenance'] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Candidate provenance unavailable')
  const source = value as Record<string, unknown>
  const classifier = source.classifier
  if (!classifier || typeof classifier !== 'object' || Array.isArray(classifier))
    throw new Error('Candidate classification unavailable')
  const kind = (classifier as Record<string, unknown>).kind
  if (
    (source.source !== 'PUBLIC' && source.source !== 'SECOND_LAYER') ||
    source.verification !== 'UNVERIFIED' ||
    typeof source.hedged !== 'boolean' ||
    (kind !== 'FACTUAL_CORRECTION' &&
      kind !== 'FACTUAL_ADDITION' &&
      kind !== 'ALIAS' &&
      kind !== 'LOCATION' &&
      kind !== 'TEMPORARY_UPDATE')
  )
    throw new Error('Candidate provenance invalid')
  return { source: source.source, kind, verification: 'UNVERIFIED', hedged: source.hedged }
}

export function projectConversationLearningCandidate(
  row: {
    id: string
    sessionId: string
    summary: string
    reviewStatus: string
    candidateRevision: number
    reviewerFeedback: string | null
    candidateProvenance: unknown
  },
  scope: { tenantId: string; venueId: string },
): ConversationLearningCandidate {
  const source = readProvenance(row.candidateProvenance)
  return {
    id: row.id,
    summary: row.summary,
    reviewStatus: row.reviewStatus,
    candidateRevision: row.candidateRevision,
    reviewerFeedback: row.reviewerFeedback,
    candidateProvenance: {
      source: source.source,
      kind: source.kind,
      verification: source.verification,
      hedged: source.hedged,
    },
    sourceHref: `/admin/clients/${encodeURIComponent(scope.tenantId)}/venues/${encodeURIComponent(scope.venueId)}/chatlogs/${encodeURIComponent(row.sessionId)}`,
  }
}
