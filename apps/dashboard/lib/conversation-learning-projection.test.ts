import { describe, expect, it } from 'vitest'

import { projectConversationLearningCandidate } from './conversation-learning-projection'

const row = {
  id: 'candidate-1',
  sessionId: 'session/with spaces?#',
  summary: 'The east entrance is step-free.',
  reviewStatus: 'UNREVIEWED',
  candidateRevision: 3,
  reviewerFeedback: null,
  candidateProvenance: {
    source: 'SECOND_LAYER',
    classifier: { kind: 'LOCATION' },
    verification: 'UNVERIFIED',
    hedged: true,
    authenticatedActorRef: 'private-user-id',
    rawSource: { transcript: 'private source text' },
    rawsource: 'another private source field',
  },
}

describe('projectConversationLearningCandidate', () => {
  it('returns the bounded UI projection and encodes every scoped source-link segment', () => {
    const projected = projectConversationLearningCandidate(row, {
      tenantId: 'tenant/acme?',
      venueId: 'venue west/#1',
    })

    expect(projected).toEqual({
      id: 'candidate-1',
      summary: 'The east entrance is step-free.',
      reviewStatus: 'UNREVIEWED',
      candidateRevision: 3,
      reviewerFeedback: null,
      candidateProvenance: {
        source: 'SECOND_LAYER',
        kind: 'LOCATION',
        verification: 'UNVERIFIED',
        hedged: true,
      },
      sourceHref:
        '/admin/clients/tenant%2Facme%3F/venues/venue%20west%2F%231/chatlogs/session%2Fwith%20spaces%3F%23',
    })
    expect(JSON.stringify(projected)).not.toMatch(
      /authenticatedActorRef|rawSource|rawsource|private-user-id|private source text/,
    )
  })

  it.each([
    ['an unverified-only boundary', { verification: 'VERIFIED' }],
    ['a bounded classifier kind', { classifier: { kind: 'INTERNAL_SECRET' } }],
    ['a bounded source scope', { source: 'PRIVATE' }],
  ])('rejects provenance outside %s', (_label, override) => {
    expect(() =>
      projectConversationLearningCandidate(
        {
          ...row,
          candidateProvenance: { ...row.candidateProvenance, ...override },
        },
        { tenantId: 'tenant-1', venueId: 'venue-1' },
      ),
    ).toThrow()
  })
})
