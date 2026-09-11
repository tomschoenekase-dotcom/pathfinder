import { z } from 'zod'

import {
  MediaEntityCandidateSchema,
  MediaEvidenceScopeSchema,
  createMediaEvidenceLocatorIndex,
  type MediaEntityCandidate,
  type MediaEvidenceScope,
} from './media-entity-resolution'

const id = z.string().min(1).max(191)
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const decisionBase = {
  requestId: uuid,
  reviewerId: id,
  rationale: z.string().trim().min(1).max(2000),
}

const relationKind = z.enum(['CONTAINS', 'ADJACENT', 'COVISIBLE', 'TRAVERSABLE'])
const relationBasis = z.enum([
  'visual_overlap',
  'explicit_containment',
  'explicit_path',
  'doorway',
  'map_route',
])
const observationTime = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('UNKNOWN') }).strict(),
  z.object({ kind: z.literal('OBSERVED_AT'), observedAt: z.string().datetime() }).strict(),
])
const traversalReview = z
  .object({
    connectionKind: z.enum([
      'WALKWAY',
      'DOOR',
      'STAIRS',
      'ELEVATOR',
      'ESCALATOR',
      'OUTDOOR_PATH',
      'SHUTTLE',
    ]),
    bidirectional: z.boolean(),
    accessibility: z.enum(['ACCESSIBLE', 'NOT_ACCESSIBLE', 'UNKNOWN']),
    directions: z.string().trim().min(1).max(2000),
  })
  .strict()

const relationProposalPayloadObject = z
  .object({
    kind: z.literal('PROPOSE_RELATION'),
    rationale: decisionBase.rationale,
    relationId: id,
    /** For CONTAINS, from is the container and to is the contained location. */
    fromCandidateId: id,
    toCandidateId: id,
    relationKind,
    evidenceLocatorIds: z.array(z.string().min(1).max(2500)).min(1).max(100),
    basis: relationBasis,
    confidence: z.enum(['confirmed', 'probable', 'unverified']),
    observationTime,
    uncertainties: z.array(z.string().trim().min(1).max(2000)).max(100),
    traversal: traversalReview.optional(),
  })
  .strict()

function validateRelationProposal(
  value: z.infer<typeof relationProposalPayloadObject>,
  context: z.RefinementCtx,
) {
  if (value.fromCandidateId === value.toCandidateId)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Relation endpoints must differ.' })
  if (new Set(value.evidenceLocatorIds).size !== value.evidenceLocatorIds.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Relation evidence must be unique.' })
  if (value.relationKind === 'TRAVERSABLE') {
    if (!['explicit_path', 'doorway', 'map_route'].includes(value.basis))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Traversability requires explicit path, doorway, or map-route evidence.',
      })
    if (!value.traversal)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Traversability requires explicit reviewed connection details.',
      })
  } else if (value.traversal) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only traversable relations may include connection details.',
    })
  }
  if (value.relationKind === 'CONTAINS' && value.basis !== 'explicit_containment')
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Containment requires explicit containment evidence.',
    })
}

export const MediaRelationProposalDecisionInputSchema =
  relationProposalPayloadObject.superRefine(validateRelationProposal)
export type MediaRelationProposalDecisionInput = z.infer<
  typeof MediaRelationProposalDecisionInputSchema
>
const proposeRelation = z
  .object({
    ...relationProposalPayloadObject.shape,
    requestId: decisionBase.requestId,
    reviewerId: decisionBase.reviewerId,
  })
  .strict()
  .superRefine(validateRelationProposal)

/** ACCEPTED records review state only; reviewer metadata grants no native-write authority. */
export const MediaRelationReviewDecisionInputSchema = z
  .object({
    kind: z.literal('REVIEW_RELATION'),
    rationale: decisionBase.rationale,
    proposalRequestId: uuid,
    verdict: z.enum(['ACCEPTED', 'REJECTED']),
  })
  .strict()
export type MediaRelationReviewDecisionInput = z.infer<
  typeof MediaRelationReviewDecisionInputSchema
>

export const MediaRelationRevertDecisionInputSchema = z
  .object({
    kind: z.literal('REVERT_RELATION'),
    rationale: decisionBase.rationale,
    reviewRequestId: uuid,
  })
  .strict()
export type MediaRelationRevertDecisionInput = z.infer<
  typeof MediaRelationRevertDecisionInputSchema
>

/** These identities exist only in media review; they grant no native/public content authority. */
export const MediaResolutionDecisionSchema = z.union([
  z
    .object({
      ...decisionBase,
      kind: z.literal('MERGE'),
      candidateIds: z.array(id).min(2).max(100),
      representativeId: id,
    })
    .strict(),
  z
    .object({
      ...decisionBase,
      kind: z.literal('REVERT_MERGE'),
      mergeRequestId: uuid,
    })
    .strict(),
  proposeRelation,
  z
    .object({
      ...MediaRelationReviewDecisionInputSchema.shape,
      requestId: decisionBase.requestId,
      reviewerId: decisionBase.reviewerId,
    })
    .strict(),
  z
    .object({
      ...MediaRelationRevertDecisionInputSchema.shape,
      requestId: decisionBase.requestId,
      reviewerId: decisionBase.reviewerId,
    })
    .strict(),
])
export type MediaResolutionDecision = z.infer<typeof MediaResolutionDecisionSchema>

export const MediaResolutionStateSchema = z
  .object({
    version: z.literal(1),
    scope: MediaEvidenceScopeSchema,
    candidates: z.array(MediaEntityCandidateSchema).min(1).max(500),
    decisions: z.array(MediaResolutionDecisionSchema).max(500),
  })
  .strict()
export type MediaResolutionState = z.infer<typeof MediaResolutionStateSchema>

type Projection = {
  representativeByCandidate: Map<string, string>
  activeMergeIds: Set<string>
  relations: Array<{
    relationId: string
    proposalRequestId: string
    originalFromCandidateId: string
    originalToCandidateId: string
    fromCandidateId: string
    toCandidateId: string
    relationKind: z.infer<typeof relationKind>
    evidenceLocatorIds: string[]
    basis: z.infer<typeof relationBasis>
    confidence: 'confirmed' | 'probable' | 'unverified'
    observationTime: z.infer<typeof observationTime>
    uncertainties: string[]
    traversal?: z.infer<typeof traversalReview>
    reviewStatus: 'PENDING' | 'ACCEPTED' | 'REJECTED'
    reviewRequestId: string | null
    endpointState: 'RESOLVED' | 'COLLAPSED'
    ambiguity: 'NONE' | 'AMBIGUOUS'
  }>
}

function projectValidatedState(state: MediaResolutionState): Projection {
  const candidateIds = new Set(state.candidates.map((candidate) => candidate.candidateId))
  if (candidateIds.size !== state.candidates.length)
    throw new Error('Candidate IDs must be unique.')
  for (const candidate of state.candidates) {
    createMediaEvidenceLocatorIndex(state.scope, candidate.evidence)
  }
  const requests = new Set<string>()
  const active = new Map<string, Extract<MediaResolutionDecision, { kind: 'MERGE' }>>()
  const proposals = new Map<
    string,
    Extract<MediaResolutionDecision, { kind: 'PROPOSE_RELATION' }>
  >()
  const activeRelationReviews = new Map<
    string,
    Extract<MediaResolutionDecision, { kind: 'REVIEW_RELATION' }>
  >()
  const relationReviewByRequest = new Map<
    string,
    Extract<MediaResolutionDecision, { kind: 'REVIEW_RELATION' }>
  >()
  const evidenceByCandidate = new Map(
    state.candidates.map((candidate) => [
      candidate.candidateId,
      createMediaEvidenceLocatorIndex(state.scope, candidate.evidence),
    ]),
  )
  const availableEvidence = new Set([...evidenceByCandidate.values()].flatMap((set) => [...set]))
  const representativeByCandidate = new Map([...candidateIds].map((value) => [value, value]))
  const rebuild = () => {
    for (const value of candidateIds) representativeByCandidate.set(value, value)
    for (const merge of active.values()) {
      for (const value of merge.candidateIds)
        representativeByCandidate.set(value, merge.representativeId)
    }
  }
  for (const decision of state.decisions) {
    if (requests.has(decision.requestId))
      throw new Error('Review decision request IDs must be unique.')
    requests.add(decision.requestId)
    if (decision.kind === 'MERGE') {
      const members = new Set(decision.candidateIds)
      if (
        members.size !== decision.candidateIds.length ||
        !members.has(decision.representativeId)
      ) {
        throw new Error('A merge needs unique candidates and a representative among them.')
      }
      if ([...members].some((member) => !candidateIds.has(member))) {
        throw new Error('A merge candidate is outside the frozen review.')
      }
      const touchedGroups = new Set(
        [...members].map((member) => representativeByCandidate.get(member)!),
      )
      if (touchedGroups.size < 2) throw new Error('The candidates are already one reviewed entity.')
      for (const [member, representative] of representativeByCandidate) {
        if (touchedGroups.has(representative) && !members.has(member)) {
          throw new Error('Merge decisions must retain every member of existing groups.')
        }
      }
      active.set(decision.requestId, decision)
      rebuild()
    } else if (decision.kind === 'REVERT_MERGE') {
      const original = active.get(decision.mergeRequestId)
      if (!original) throw new Error('The referenced merge is not active.')
      const members = new Set(original.candidateIds)
      let afterOriginal = false
      for (const merge of active.values()) {
        if (merge.requestId === original.requestId) {
          afterOriginal = true
          continue
        }
        if (afterOriginal && merge.candidateIds.some((member) => members.has(member))) {
          throw new Error('Revert dependent merges first so source references remain consistent.')
        }
      }
      active.delete(original.requestId)
      rebuild()
    } else if (decision.kind === 'PROPOSE_RELATION') {
      if (proposals.has(decision.relationId))
        throw new Error('Relation IDs must be unique within a review.')
      const fromEvidence = evidenceByCandidate.get(decision.fromCandidateId)
      const toEvidence = evidenceByCandidate.get(decision.toCandidateId)
      if (!fromEvidence || !toEvidence)
        throw new Error('Relation endpoint candidate is outside the frozen review.')
      if (decision.evidenceLocatorIds.some((locator) => !availableEvidence.has(locator)))
        throw new Error('Relation references evidence outside the frozen review.')
      if (
        !decision.evidenceLocatorIds.some((locator) => fromEvidence.has(locator)) ||
        !decision.evidenceLocatorIds.some((locator) => toEvidence.has(locator))
      )
        throw new Error('Relation evidence must retain both original endpoint candidates.')
      proposals.set(decision.relationId, decision)
    } else if (decision.kind === 'REVIEW_RELATION') {
      const proposal = [...proposals.values()].find(
        (entry) => entry.requestId === decision.proposalRequestId,
      )
      if (!proposal) throw new Error('Relation review references an unavailable proposal.')
      if (activeRelationReviews.has(proposal.requestId))
        throw new Error('Revert the active relation review before reviewing it again.')
      activeRelationReviews.set(proposal.requestId, decision)
      relationReviewByRequest.set(decision.requestId, decision)
    } else {
      const review = relationReviewByRequest.get(decision.reviewRequestId)
      if (!review || activeRelationReviews.get(review.proposalRequestId) !== review)
        throw new Error('The referenced relation review is not active.')
      activeRelationReviews.delete(review.proposalRequestId)
    }
  }
  const relations = [...proposals.values()].map((proposal) => {
    const review = activeRelationReviews.get(proposal.requestId)
    const fromCandidateId = representativeByCandidate.get(proposal.fromCandidateId)!
    const toCandidateId = representativeByCandidate.get(proposal.toCandidateId)!
    return {
      relationId: proposal.relationId,
      proposalRequestId: proposal.requestId,
      originalFromCandidateId: proposal.fromCandidateId,
      originalToCandidateId: proposal.toCandidateId,
      fromCandidateId,
      toCandidateId,
      relationKind: proposal.relationKind,
      evidenceLocatorIds: proposal.evidenceLocatorIds,
      basis: proposal.basis,
      confidence: proposal.confidence,
      observationTime: proposal.observationTime,
      uncertainties: proposal.uncertainties,
      ...(proposal.traversal ? { traversal: proposal.traversal } : {}),
      reviewStatus: review?.verdict ?? ('PENDING' as const),
      reviewRequestId: review?.requestId ?? null,
      endpointState:
        fromCandidateId === toCandidateId ? ('COLLAPSED' as const) : ('RESOLVED' as const),
      ambiguity: 'NONE' as 'NONE' | 'AMBIGUOUS',
    }
  })
  const acceptedGroups = new Map<string, typeof relations>()
  for (const relation of relations) {
    if (relation.reviewStatus !== 'ACCEPTED' || relation.endpointState === 'COLLAPSED') continue
    const directed =
      relation.relationKind === 'CONTAINS' || relation.traversal?.bidirectional === false
    const endpoints = directed
      ? [relation.fromCandidateId, relation.toCandidateId]
      : [relation.fromCandidateId, relation.toCandidateId].sort()
    const key = JSON.stringify([relation.relationKind, ...endpoints])
    const group = acceptedGroups.get(key) ?? []
    group.push(relation)
    acceptedGroups.set(key, group)
  }
  for (const group of acceptedGroups.values()) {
    if (group.length > 1) for (const relation of group) relation.ambiguity = 'AMBIGUOUS'
  }
  return { representativeByCandidate, activeMergeIds: new Set(active.keys()), relations }
}

export function createMediaResolutionState(
  scope: MediaEvidenceScope,
  candidates: MediaEntityCandidate[],
) {
  const state = MediaResolutionStateSchema.parse({ version: 1, scope, candidates, decisions: [] })
  projectValidatedState(state)
  return state
}

export function appendMediaResolutionDecision(
  input: unknown,
  decisionInput: unknown,
): MediaResolutionState {
  const current = MediaResolutionStateSchema.parse(input)
  projectValidatedState(current)
  const decision = MediaResolutionDecisionSchema.parse(decisionInput)
  const existing = current.decisions.find((entry) => entry.requestId === decision.requestId)
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(decision))
      throw new Error('Review request already has a different decision.')
    return current
  }
  const next = MediaResolutionStateSchema.parse({
    ...current,
    decisions: [...current.decisions, decision],
  })
  projectValidatedState(next)
  return next
}

/** Resolve references from their original candidate IDs every time; reversal never loses lineage. */
export function projectMediaResolution(input: unknown) {
  const state = MediaResolutionStateSchema.parse(input)
  const { representativeByCandidate, activeMergeIds, relations } = projectValidatedState(state)
  const groups = new Map<string, string[]>()
  for (const [candidate, representative] of representativeByCandidate) {
    const members = groups.get(representative) ?? []
    members.push(candidate)
    groups.set(representative, members)
  }
  return {
    groups: [...groups].map(([representativeId, candidateIds]) => ({
      representativeId,
      candidateIds,
    })),
    references: [...representativeByCandidate].map(([candidateId, representativeId]) => ({
      candidateId,
      representativeId,
    })),
    activeMergeIds: [...activeMergeIds],
    relations,
    decisionCount: state.decisions.length,
  }
}
