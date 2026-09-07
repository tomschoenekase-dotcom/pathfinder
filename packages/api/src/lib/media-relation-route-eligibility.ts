import { z } from 'zod'
import { MediaResolutionStateSchema } from '@pathfinder/contracts/media-resolution-state'

import { ApplyMediaRelationInput, reviewedTraversalDraft } from './media-relation-application'
import { mediaIntakeHash } from './media-intake-snapshot'

const id = z.string().min(1).max(191)
const generation = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const connection = z
  .object({
    id,
    tenantId: id,
    venueId: id,
    fromLocationId: z.string().uuid(),
    toLocationId: z.string().uuid(),
    kind: z.enum(['WALKWAY', 'DOOR', 'STAIRS', 'ELEVATOR', 'ESCALATOR', 'OUTDOOR_PATH', 'SHUTTLE']),
    bidirectional: z.boolean(),
    accessible: z.boolean(),
    directions: z.string().max(2000).nullable(),
    isActive: z.boolean(),
  })
  .strict()

const inputSchema = z
  .object({
    currentProject: z
      .object({
        tenantId: id,
        venueId: id,
        projectId: id,
        sourceGeneration: generation,
        uploadAttemptId: z.string().uuid().optional(),
      })
      .strict(),
    receiptRevision: z
      .object({ tenantId: id, venueId: id, projectId: id, sourceGeneration: generation })
      .strict(),
    receipt: z
      .object({
        connectionId: z.string().uuid(),
        requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
        actorId: id,
        inputSnapshot: z.unknown(),
      })
      .strict(),
    currentState: z.unknown(),
    connection,
  })
  .strict()

export type MediaRelationRouteEligibilityReason =
  | 'ELIGIBLE'
  | 'INACTIVE_CONNECTION'
  | 'SCOPE_CHANGED'
  | 'SOURCE_GENERATION_CHANGED'
  | 'INVALID_RECEIPT'
  | 'REVIEW_NO_LONGER_ACCEPTED'
  | 'REVIEWED_ROUTE_CHANGED'
  | 'CONNECTION_CHANGED'

function held(reason: Exclude<MediaRelationRouteEligibilityReason, 'ELIGIBLE'>) {
  return { eligible: false as const, reason }
}

/**
 * Rechecks a media-origin route against current reviewed source state. It grants no
 * activation authority: the canonical connection must independently remain active.
 */
export function assessMediaRelationRouteEligibility(
  value: unknown,
):
  | { eligible: true; reason: 'ELIGIBLE' }
  | { eligible: false; reason: Exclude<MediaRelationRouteEligibilityReason, 'ELIGIBLE'> } {
  const parsed = inputSchema.safeParse(value)
  if (!parsed.success) return held('INVALID_RECEIPT')
  const { currentProject, receiptRevision, receipt, currentState } = parsed.data
  const native = parsed.data.connection
  const state = MediaResolutionStateSchema.safeParse(currentState)
  if (
    currentProject.tenantId !== receiptRevision.tenantId ||
    currentProject.venueId !== receiptRevision.venueId ||
    currentProject.projectId !== receiptRevision.projectId ||
    native.tenantId !== receiptRevision.tenantId ||
    native.venueId !== receiptRevision.venueId ||
    !state.success ||
    state.data.scope.tenantId !== currentProject.tenantId ||
    state.data.scope.projectId !== currentProject.projectId ||
    (currentProject.uploadAttemptId !== undefined &&
      state.data.scope.uploadAttemptId !== currentProject.uploadAttemptId)
  )
    return held('SCOPE_CHANGED')
  if (currentProject.sourceGeneration !== receiptRevision.sourceGeneration)
    return held('SOURCE_GENERATION_CHANGED')
  if (!native.isActive) return held('INACTIVE_CONNECTION')

  const snapshot = receipt.inputSnapshot as {
    input?: unknown
    actorId?: unknown
    reviewedDraft?: unknown
    stateHash?: unknown
  } | null
  const storedInput = ApplyMediaRelationInput.safeParse(snapshot?.input)
  if (
    !snapshot ||
    !storedInput.success ||
    snapshot.actorId !== receipt.actorId ||
    typeof snapshot.stateHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(snapshot.stateHash) ||
    mediaIntakeHash({ input: snapshot.input, actorId: snapshot.actorId }) !== receipt.requestHash ||
    receipt.connectionId !== native.id ||
    receipt.connectionId !== storedInput.data.requestId ||
    storedInput.data.tenantId !== receiptRevision.tenantId ||
    storedInput.data.venueId !== receiptRevision.venueId ||
    storedInput.data.projectId !== receiptRevision.projectId ||
    storedInput.data.sourceGeneration !== receiptRevision.sourceGeneration
  )
    return held('INVALID_RECEIPT')

  let currentDraft: ReturnType<typeof reviewedTraversalDraft>
  try {
    currentDraft = reviewedTraversalDraft(
      state.data,
      storedInput.data.relationId,
      storedInput.data.relationReviewRequestId,
    )
  } catch {
    return held('REVIEW_NO_LONGER_ACCEPTED')
  }
  if (mediaIntakeHash(currentDraft) !== mediaIntakeHash(snapshot.reviewedDraft))
    return held('REVIEWED_ROUTE_CHANGED')
  if (
    native.fromLocationId !== storedInput.data.fromLocationId ||
    native.toLocationId !== storedInput.data.toLocationId ||
    native.kind !== currentDraft.kind ||
    native.bidirectional !== currentDraft.bidirectional ||
    native.accessible !== currentDraft.accessible ||
    native.directions !== currentDraft.directions
  )
    return held('CONNECTION_CHANGED')
  return { eligible: true, reason: 'ELIGIBLE' }
}
