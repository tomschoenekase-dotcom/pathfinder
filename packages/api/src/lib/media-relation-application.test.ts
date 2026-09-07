import { describe, expect, it } from 'vitest'
import {
  createMediaResolutionState,
  appendMediaResolutionDecision,
} from '@pathfinder/contracts/media-resolution-state'
import { mediaEvidenceLocatorId } from '@pathfinder/contracts/media-entity-resolution'
import { reviewedTraversalDraft } from './media-relation-application'

const scope = {
  tenantId: 'tenant',
  projectId: 'project',
  uploadAttemptId: '11111111-1111-4111-8111-111111111111',
}
const request = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function fixture(
  options: {
    kind?: 'ADJACENT' | 'TRAVERSABLE'
    confidence?: 'confirmed' | 'probable'
    accessibility?: 'UNKNOWN' | 'ACCESSIBLE'
  } = {},
) {
  const candidates = ['a', 'b'].map((candidateId) => ({
    candidateId,
    label: candidateId,
    kind: 'location',
    identifiers: [],
    contextKeys: [],
    evidence: [
      {
        ...scope,
        sourceId: candidateId,
        sourceSha256: 'a'.repeat(64),
        observationIndex: 0,
        observationSha256: 'b'.repeat(64),
      },
    ],
  }))
  let state = createMediaResolutionState(scope, candidates)
  state = appendMediaResolutionDecision(state, {
    kind: 'PROPOSE_RELATION',
    requestId: request(1),
    reviewerId: 'admin',
    rationale: 'Reviewed explicit doorway evidence.',
    relationId: 'door-a-b',
    fromCandidateId: 'a',
    toCandidateId: 'b',
    relationKind: options.kind ?? 'TRAVERSABLE',
    basis: options.kind === 'ADJACENT' ? 'visual_overlap' : 'doorway',
    confidence: options.confidence ?? 'confirmed',
    observationTime: { kind: 'UNKNOWN' },
    uncertainties: [],
    evidenceLocatorIds: candidates.flatMap((candidate) =>
      candidate.evidence.map(mediaEvidenceLocatorId),
    ),
    ...(options.kind === 'ADJACENT'
      ? {}
      : {
          traversal: {
            connectionKind: 'DOOR' as const,
            bidirectional: false,
            accessibility: options.accessibility ?? 'ACCESSIBLE',
            directions: 'Use the reviewed doorway beside the gallery sign.',
          },
        }),
  })
  return appendMediaResolutionDecision(state, {
    kind: 'REVIEW_RELATION',
    requestId: request(2),
    reviewerId: 'admin',
    rationale: 'Accepted reviewed path details.',
    proposalRequestId: request(1),
    verdict: 'ACCEPTED',
  })
}
describe('canonical relation draft boundary', () => {
  it('retains reviewed path details and original references in an inactive draft', () => {
    expect(reviewedTraversalDraft(fixture(), 'door-a-b', request(2))).toMatchObject({
      originalFromCandidateId: 'a',
      originalToCandidateId: 'b',
      kind: 'DOOR',
      bidirectional: false,
      accessible: true,
      isActive: false,
      observationTime: { kind: 'UNKNOWN' },
    })
  })
  it('never turns reviewed adjacency into a path', () => {
    expect(() =>
      reviewedTraversalDraft(fixture({ kind: 'ADJACENT' }), 'door-a-b', request(2)),
    ).toThrow(/do not authorize/)
  })
  it('keeps probable path and unknown accessibility pending explicit review', () => {
    expect(() =>
      reviewedTraversalDraft(fixture({ confidence: 'probable' }), 'door-a-b', request(2)),
    ).toThrow(/Confirm the path/)
    expect(() =>
      reviewedTraversalDraft(fixture({ accessibility: 'UNKNOWN' }), 'door-a-b', request(2)),
    ).toThrow(/unknown accessibility/)
  })
  it('rejects changed review identity and collapsed endpoints', () => {
    expect(() => reviewedTraversalDraft(fixture(), 'door-a-b', request(9))).toThrow(
      /exact accepted/,
    )
    const collapsed = appendMediaResolutionDecision(fixture(), {
      kind: 'MERGE',
      requestId: request(3),
      reviewerId: 'admin',
      rationale: 'These views refer to the same room.',
      candidateIds: ['a', 'b'],
      representativeId: 'a',
    })
    expect(() => reviewedTraversalDraft(collapsed, 'door-a-b', request(2))).toThrow(/collapsed/)
  })
})
