import { describe, expect, it } from 'vitest'

import {
  appendMediaResolutionDecision,
  createMediaResolutionState,
} from '@pathfinder/contracts/media-resolution-state'
import { mediaEvidenceLocatorId } from '@pathfinder/contracts/media-entity-resolution'

import { reviewedTraversalDraft } from './media-relation-application'
import { assessMediaRelationRouteEligibility } from './media-relation-route-eligibility'
import { mediaIntakeHash } from './media-intake-snapshot'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenantId = 'tenant-a'
const venueId = 'venue-a'
const projectId = 'project-a'
const sourceGeneration = uuid(90)
const uploadAttemptId = uuid(91)

function reviewedState() {
  const candidates = ['a', 'b', 'c', 'd'].map((candidateId) => ({
    candidateId,
    label: candidateId,
    kind: 'location' as const,
    identifiers: [],
    contextKeys: [],
    evidence: [
      {
        tenantId,
        projectId,
        uploadAttemptId,
        sourceId: candidateId,
        sourceSha256: 'a'.repeat(64),
        observationIndex: 0,
        observationSha256: 'b'.repeat(64),
      },
    ],
  }))
  let state = createMediaResolutionState({ tenantId, projectId, uploadAttemptId }, candidates)
  state = appendMediaResolutionDecision(state, {
    kind: 'PROPOSE_RELATION',
    requestId: uuid(1),
    reviewerId: 'admin',
    rationale: 'A reviewed doorway connects the two locations.',
    relationId: 'door-a-b',
    fromCandidateId: 'a',
    toCandidateId: 'b',
    relationKind: 'TRAVERSABLE',
    basis: 'doorway',
    confidence: 'confirmed',
    observationTime: { kind: 'UNKNOWN' },
    uncertainties: [],
    evidenceLocatorIds: candidates
      .slice(0, 2)
      .flatMap((candidate) => candidate.evidence.map(mediaEvidenceLocatorId)),
    traversal: {
      connectionKind: 'DOOR',
      bidirectional: false,
      accessibility: 'ACCESSIBLE',
      directions: 'Use the signed doorway.',
    },
  })
  return appendMediaResolutionDecision(state, {
    kind: 'REVIEW_RELATION',
    requestId: uuid(2),
    reviewerId: 'admin',
    rationale: 'Accepted the explicit route evidence.',
    proposalRequestId: uuid(1),
    verdict: 'ACCEPTED',
  })
}

function fixture() {
  const currentState = reviewedState()
  const input = {
    tenantId,
    venueId,
    projectId,
    sourceGeneration,
    revisionId: uuid(92),
    relationId: 'door-a-b',
    relationReviewRequestId: uuid(2),
    requestId: uuid(93),
    expectedMediaUpdatedAt: '2026-09-07T10:00:00.000Z',
    fromLocationId: uuid(94),
    fromLocationUpdatedAt: '2026-09-07T10:00:00.000Z',
    toLocationId: uuid(95),
    toLocationUpdatedAt: '2026-09-07T10:00:00.000Z',
    rationale: 'Create an inactive route draft from reviewed evidence.',
  }
  const reviewedDraft = reviewedTraversalDraft(
    currentState,
    input.relationId,
    input.relationReviewRequestId,
  )
  return {
    currentProject: { tenantId, venueId, projectId, sourceGeneration, uploadAttemptId },
    receiptRevision: { tenantId, venueId, projectId, sourceGeneration },
    receipt: {
      connectionId: input.requestId,
      requestHash: mediaIntakeHash({ input, actorId: 'admin' }),
      actorId: 'admin',
      inputSnapshot: {
        input,
        actorId: 'admin',
        reviewedDraft,
        stateHash: mediaIntakeHash(currentState),
      },
    },
    currentState,
    connection: {
      id: input.requestId,
      tenantId,
      venueId,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      kind: reviewedDraft.kind,
      bidirectional: reviewedDraft.bidirectional,
      accessible: reviewedDraft.accessible,
      directions: reviewedDraft.directions,
      isActive: true,
    },
  }
}

describe('assessMediaRelationRouteEligibility', () => {
  it('accepts an active canonical connection that still matches its exact reviewed receipt', () => {
    expect(assessMediaRelationRouteEligibility(fixture())).toEqual({
      eligible: true,
      reason: 'ELIGIBLE',
    })
  })

  it('binds a renewal receipt to its existing canonical connection instead of the new request ID', () => {
    const value = fixture()
    const existingId = uuid(97)
    const snapshot = value.receipt.inputSnapshot
    snapshot.input = {
      ...snapshot.input,
      existingConnection: {
        id: existingId,
        expectedUpdatedAt: '2026-09-07T11:00:00.000Z',
      },
    } as typeof snapshot.input
    value.receipt.connectionId = existingId
    value.receipt.requestHash = mediaIntakeHash({ input: snapshot.input, actorId: 'admin' })
    value.connection.id = existingId
    expect(assessMediaRelationRouteEligibility(value)).toEqual({
      eligible: true,
      reason: 'ELIGIBLE',
    })
  })

  it('does not treat receipt metadata as activation', () => {
    const value = fixture()
    value.connection.isActive = false
    expect(assessMediaRelationRouteEligibility(value)).toEqual({
      eligible: false,
      reason: 'INACTIVE_CONNECTION',
    })
  })

  it('holds a route when its source generation or canonical fields change', () => {
    const generationChanged = fixture()
    generationChanged.currentProject.sourceGeneration = uuid(99)
    expect(assessMediaRelationRouteEligibility(generationChanged).reason).toBe(
      'SOURCE_GENERATION_CHANGED',
    )
    const nativeChanged = fixture()
    nativeChanged.connection.directions = 'Use another corridor.'
    expect(assessMediaRelationRouteEligibility(nativeChanged).reason).toBe('CONNECTION_CHANGED')
  })

  it('rejects a current resolution state from another scoped project or upload attempt', () => {
    const value = fixture()
    value.currentProject.uploadAttemptId = uuid(98)
    expect(assessMediaRelationRouteEligibility(value)).toEqual({
      eligible: false,
      reason: 'SCOPE_CHANGED',
    })
  })

  it('ignores unrelated resolution decisions when the reviewed route is unchanged', () => {
    const value = fixture()
    value.currentState = appendMediaResolutionDecision(value.currentState, {
      kind: 'MERGE',
      requestId: uuid(3),
      reviewerId: 'admin',
      rationale: 'Two unrelated views identify the same location.',
      candidateIds: ['c', 'd'],
      representativeId: 'c',
    })
    expect(assessMediaRelationRouteEligibility(value)).toEqual({
      eligible: true,
      reason: 'ELIGIBLE',
    })
  })

  it('holds a collapsed relation and restores eligibility after the exact merge is reverted', () => {
    const value = fixture()
    const collapsed = appendMediaResolutionDecision(value.currentState, {
      kind: 'MERGE',
      requestId: uuid(3),
      reviewerId: 'admin',
      rationale: 'Temporarily treated both endpoints as one location.',
      candidateIds: ['a', 'b'],
      representativeId: 'a',
    })
    value.currentState = collapsed
    expect(assessMediaRelationRouteEligibility(value).reason).toBe('REVIEW_NO_LONGER_ACCEPTED')
    value.currentState = appendMediaResolutionDecision(collapsed, {
      kind: 'REVERT_MERGE',
      requestId: uuid(4),
      reviewerId: 'admin',
      rationale: 'Restored the distinct reviewed route endpoints.',
      mergeRequestId: uuid(3),
    })
    expect(assessMediaRelationRouteEligibility(value)).toEqual({
      eligible: true,
      reason: 'ELIGIBLE',
    })
  })

  it('holds reverted or replaced relation reviews and tampered receipt drafts', () => {
    const reverted = fixture()
    reverted.currentState = appendMediaResolutionDecision(reverted.currentState, {
      kind: 'REVERT_RELATION',
      requestId: uuid(5),
      reviewerId: 'admin',
      rationale: 'The route requires another review.',
      reviewRequestId: uuid(2),
    })
    expect(assessMediaRelationRouteEligibility(reverted).reason).toBe('REVIEW_NO_LONGER_ACCEPTED')
    const tampered = fixture()
    ;(tampered.receipt.inputSnapshot.reviewedDraft as { directions: string }).directions = 'Changed'
    expect(assessMediaRelationRouteEligibility(tampered).reason).toBe('REVIEWED_ROUTE_CHANGED')
  })
})
