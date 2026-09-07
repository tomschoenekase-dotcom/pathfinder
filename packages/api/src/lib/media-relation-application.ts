import { z } from 'zod'
import {
  MediaResolutionStateSchema,
  projectMediaResolution,
} from '@pathfinder/contracts/media-resolution-state'

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const id = z.string().trim().min(1).max(191)

/** Platform-human route only. This request creates an inactive draft, never a public route. */
export const ApplyMediaRelationInput = z
  .object({
    tenantId: id,
    venueId: id,
    projectId: id,
    sourceGeneration: uuid,
    revisionId: uuid,
    relationId: id,
    relationReviewRequestId: uuid,
    requestId: uuid,
    expectedMediaUpdatedAt: z.string().datetime(),
    fromLocationId: uuid,
    fromLocationUpdatedAt: z.string().datetime(),
    toLocationId: uuid,
    toLocationUpdatedAt: z.string().datetime(),
    rationale: z.string().trim().min(1).max(2000),
  })
  .strict()
  .refine((input) => input.fromLocationId !== input.toLocationId, {
    message: 'A route draft requires different canonical location anchors.',
  })

export function reviewedTraversalDraft(
  stateInput: unknown,
  relationId: string,
  reviewRequestId: string,
) {
  const state = MediaResolutionStateSchema.parse(stateInput)
  const relation = projectMediaResolution(state).relations.find(
    (item) => item.relationId === relationId,
  )
  if (
    !relation ||
    relation.reviewStatus !== 'ACCEPTED' ||
    relation.reviewRequestId !== reviewRequestId
  ) {
    throw new Error('The exact accepted relation review is unavailable.')
  }
  if (relation.relationKind !== 'TRAVERSABLE' || !relation.traversal) {
    throw new Error(
      'Containment, adjacency and co-visibility do not authorize a walking connection.',
    )
  }
  if (relation.endpointState !== 'RESOLVED' || relation.ambiguity !== 'NONE') {
    throw new Error(
      'Resolve collapsed or ambiguous relation endpoints before creating a route draft.',
    )
  }
  if (relation.confidence !== 'confirmed') {
    throw new Error('Confirm the path evidence before creating a canonical route draft.')
  }
  if (relation.traversal.accessibility === 'UNKNOWN') {
    throw new Error(
      'Review accessibility explicitly; unknown accessibility cannot become a verified route field.',
    )
  }
  return {
    originalFromCandidateId: relation.originalFromCandidateId,
    originalToCandidateId: relation.originalToCandidateId,
    fromCandidateId: relation.fromCandidateId,
    toCandidateId: relation.toCandidateId,
    kind: relation.traversal.connectionKind,
    bidirectional: relation.traversal.bidirectional,
    accessible: relation.traversal.accessibility === 'ACCESSIBLE',
    directions: relation.traversal.directions,
    evidenceLocatorIds: relation.evidenceLocatorIds,
    uncertainties: relation.uncertainties,
    observationTime: relation.observationTime,
    isActive: false as const,
  }
}
