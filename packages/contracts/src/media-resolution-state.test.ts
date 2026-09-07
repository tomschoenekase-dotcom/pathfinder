import { describe, expect, it } from 'vitest'

import {
  appendMediaResolutionDecision,
  createMediaResolutionState,
  projectMediaResolution,
} from './media-resolution-state'

const scope = {
  tenantId: 'tenant-a',
  projectId: 'project-a',
  uploadAttemptId: '11111111-1111-4111-8111-111111111111',
}
const candidate = (candidateId: string) => ({
  candidateId,
  label: 'Similar greenhouse',
  kind: 'building',
  identifiers: [],
  contextKeys: [],
  evidence: [
    {
      ...scope,
      sourceId: candidateId + '.jpg',
      sourceSha256: 'a'.repeat(64),
      observationIndex: 0,
      observationSha256: 'b'.repeat(64),
    },
  ],
})
const initial = () => createMediaResolutionState(scope, ['a', 'b', 'c', 'd', 'e'].map(candidate))
const request = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`
const merge = (n: number, candidateIds: string[], representativeId = candidateIds[0]!) => ({
  kind: 'MERGE',
  requestId: request(n),
  candidateIds,
  representativeId,
  reviewerId: 'reviewer-a',
  rationale: 'Reviewed matching inventory identifiers in the retained source views.',
})
const revert = (n: number, original: number) => ({
  kind: 'REVERT_MERGE',
  requestId: request(n),
  mergeRequestId: request(original),
  reviewerId: 'reviewer-a',
  rationale: 'The source views show distinct greenhouses.',
})

describe('reversible media review identities', () => {
  it('canonicalizes logical UUID identity for retry, reversal and persisted scope', () => {
    const upperScope = { ...scope, uploadAttemptId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }
    const upperCandidate = candidate('a')
    upperCandidate.evidence[0]!.uploadAttemptId = upperScope.uploadAttemptId
    expect(createMediaResolutionState(upperScope, [upperCandidate]).scope.uploadAttemptId).toBe(
      upperScope.uploadAttemptId.toLowerCase(),
    )
    const upper = { ...merge(1, ['a', 'b']), requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }
    const first = appendMediaResolutionDecision(initial(), upper)
    expect(
      appendMediaResolutionDecision(first, { ...upper, requestId: upper.requestId.toLowerCase() }),
    ).toEqual(first)
    const undone = appendMediaResolutionDecision(first, {
      ...revert(2, 1),
      mergeRequestId: upper.requestId.toLowerCase(),
    })
    expect(projectMediaResolution(undone).activeMergeIds).toEqual([])
    expect(() =>
      projectMediaResolution({
        ...initial(),
        decisions: [upper, { ...upper, requestId: upper.requestId.toLowerCase() }],
      }),
    ).toThrow(/unique/)
  })
  it('preserves a sibling group when reversing a shared dependent merge', () => {
    const a = appendMediaResolutionDecision(initial(), merge(1, ['a', 'b']))
    const b = appendMediaResolutionDecision(a, merge(2, ['c', 'd']))
    const all = appendMediaResolutionDecision(b, merge(3, ['a', 'b', 'c', 'd']))
    expect(() => appendMediaResolutionDecision(all, revert(4, 2))).toThrow(/dependent/)
    const topUndone = appendMediaResolutionDecision(all, revert(4, 3))
    const leftUndone = appendMediaResolutionDecision(topUndone, revert(5, 1))
    expect(projectMediaResolution(leftUndone).groups).toContainEqual({
      representativeId: 'c',
      candidateIds: ['c', 'd'],
    })
    expect(
      projectMediaResolution(leftUndone).references.find((x) => x.candidateId === 'b')
        ?.representativeId,
    ).toBe('b')
  })
  it('retains conflicting extraction metadata when a reviewer explicitly overrides it', () => {
    const a = candidate('a'),
      b = candidate('b')
    b.kind = 'sculpture'
    const state = createMediaResolutionState(scope, [a, b])
    const reviewed = appendMediaResolutionDecision(state, {
      ...merge(1, ['a', 'b']),
      rationale:
        'The plaque confirms these are two views of the same sculpture; the building classification was wrong.',
    })
    expect(reviewed.candidates).toEqual(state.candidates)
    expect(projectMediaResolution(reviewed).groups).toHaveLength(1)
  })
  it('keeps visually similar names distinct until an explicit decision', () => {
    expect(projectMediaResolution(initial()).groups).toHaveLength(5)
  })
  it('restores source references and evidence after a corrected merge while retaining unrelated decisions', () => {
    const original = initial()
    const joined = appendMediaResolutionDecision(original, merge(1, ['a', 'b']))
    const unrelated = appendMediaResolutionDecision(joined, merge(2, ['d', 'e']))
    const corrected = appendMediaResolutionDecision(unrelated, revert(3, 1))
    expect(
      projectMediaResolution(joined).references.find((x) => x.candidateId === 'b')
        ?.representativeId,
    ).toBe('a')
    expect(
      projectMediaResolution(corrected).references.find((x) => x.candidateId === 'b')
        ?.representativeId,
    ).toBe('b')
    expect(projectMediaResolution(corrected).activeMergeIds).toEqual([request(2)])
    expect(corrected.candidates).toEqual(original.candidates)
    expect(corrected.decisions).toHaveLength(3)
    expect(original.decisions).toHaveLength(0)
  })
  it('requires dependent merges to be undone first, then restores the full identity map', () => {
    const first = appendMediaResolutionDecision(initial(), merge(1, ['a', 'b']))
    const second = appendMediaResolutionDecision(first, merge(2, ['a', 'b', 'c'], 'c'))
    expect(() => appendMediaResolutionDecision(second, revert(3, 1))).toThrow(/dependent/)
    const undoneSecond = appendMediaResolutionDecision(second, revert(3, 2))
    const undoneFirst = appendMediaResolutionDecision(undoneSecond, revert(4, 1))
    expect(projectMediaResolution(undoneFirst).groups).toEqual(
      projectMediaResolution(initial()).groups,
    )
  })
  it('rejects dropping members of a previously merged group', () => {
    const first = appendMediaResolutionDecision(initial(), merge(1, ['a', 'b']))
    expect(() => appendMediaResolutionDecision(first, merge(2, ['b', 'c']))).toThrow(/every member/)
  })
  it('rejects missing candidates, repeated members and representatives outside the merge', () => {
    expect(() => appendMediaResolutionDecision(initial(), merge(1, ['a', 'missing']))).toThrow(
      /outside/,
    )
    expect(() => appendMediaResolutionDecision(initial(), merge(1, ['a', 'a']))).toThrow(/unique/)
    expect(() => appendMediaResolutionDecision(initial(), merge(1, ['a', 'b'], 'c'))).toThrow(
      /representative/,
    )
  })
  it('converges exact request retries and rejects changed decisions or double reversal', () => {
    const first = appendMediaResolutionDecision(initial(), merge(1, ['a', 'b']))
    expect(appendMediaResolutionDecision(first, merge(1, ['a', 'b']))).toEqual(first)
    expect(() => appendMediaResolutionDecision(first, merge(1, ['a', 'c']))).toThrow(/different/)
    const undone = appendMediaResolutionDecision(first, revert(2, 1))
    expect(() => appendMediaResolutionDecision(undone, revert(3, 1))).toThrow(/not active/)
  })
  it('rejects mixed source authority and duplicate original identities', () => {
    const wrong = candidate('b')
    wrong.evidence[0]!.tenantId = 'other-tenant'
    expect(() => createMediaResolutionState(scope, [candidate('a'), wrong])).toThrow(/different/)
    expect(() => createMediaResolutionState(scope, [candidate('a'), candidate('a')])).toThrow(
      /unique/,
    )
  })
  it('revalidates persisted histories instead of trusting a claimed projection', () => {
    const poisoned = { ...initial(), decisions: [merge(1, ['a', 'missing'])] }
    expect(() => projectMediaResolution(poisoned)).toThrow(/outside/)
  })
})
