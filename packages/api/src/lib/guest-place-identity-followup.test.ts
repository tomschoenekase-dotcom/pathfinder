import { describe, expect, it } from 'vitest'

import { resolveGuestPlaceIdentityFollowup } from './guest-place-identity-followup'

const first = {
  id: 'first-case-12',
  name: 'Case 12',
  floor: 'First floor',
  location: 'West gallery',
}
const second = {
  id: 'second-case-12',
  name: 'Case 12',
  floor: 'Second floor',
  location: 'East gallery',
}
const pending = { requestedName: 'Case 12', candidates: [first, second] }

describe('resolveGuestPlaceIdentityFollowup', () => {
  it('accepts a whole normalized bare floor or location label', () => {
    expect(
      resolveGuestPlaceIdentityFollowup({
        rawReply: '  WEST-GALLERY  ',
        pending,
        currentCandidates: [first, second],
      }),
    ).toBe('Case 12 WEST-GALLERY')
    expect(
      resolveGuestPlaceIdentityFollowup({
        rawReply: 'second floor',
        pending,
        currentCandidates: [first, second],
      }),
    ).toBe('Case 12 second floor')
  })

  it('accepts the suffix of a floor-prefixed location label', () => {
    const prefixed = { ...first, location: 'First floor East gallery' }
    expect(
      resolveGuestPlaceIdentityFollowup({
        rawReply: 'East gallery',
        pending: { requestedName: 'Case 12', candidates: [prefixed] },
        currentCandidates: [prefixed],
      }),
    ).toBe('Case 12 East gallery')
  })

  it('fails closed when the stored anchor is removed or relabelled', () => {
    expect(
      resolveGuestPlaceIdentityFollowup({
        rawReply: 'West gallery',
        pending,
        currentCandidates: [second],
      }),
    ).toBeNull()
    expect(
      resolveGuestPlaceIdentityFollowup({
        rawReply: 'West gallery',
        pending,
        currentCandidates: [{ ...first, location: 'North gallery' }, second],
      }),
    ).toBeNull()
  })

  it('retains a newly added duplicate in the caller universe without selecting it', () => {
    const added = {
      id: 'new-case-12',
      name: 'Case 12',
      floor: 'First floor',
      location: 'West gallery',
    }
    expect(
      resolveGuestPlaceIdentityFollowup({
        rawReply: 'West gallery',
        pending,
        currentCandidates: [first, second, added],
      }),
    ).toBe('Case 12 West gallery')
  })

  it('does not let an unrelated stored anchor authorize the requested name', () => {
    expect(
      resolveGuestPlaceIdentityFollowup({
        rawReply: 'West gallery',
        pending: { requestedName: 'Case 12', candidates: [first, { ...second, name: 'Case 13' }] },
        currentCandidates: [first, { ...second, name: 'Case 13' }],
      }),
    ).toBe('Case 12 West gallery')
    expect(
      resolveGuestPlaceIdentityFollowup({
        rawReply: 'East gallery',
        pending: { requestedName: 'Case 12', candidates: [{ ...second, name: 'Case 13' }] },
        currentCandidates: [{ ...second, name: 'Case 13' }, first],
      }),
    ).toBeNull()
  })

  it('rejects arbitrary prose, explicit exhibit questions, comparisons, and unrelated labels', () => {
    for (const rawReply of [
      'Which Case 13?',
      'Compare the west and east galleries',
      'I would like the west gallery please',
      'Case 13',
      'North gallery',
      'West',
    ]) {
      expect(
        resolveGuestPlaceIdentityFollowup({
          rawReply,
          pending,
          currentCandidates: [first, second],
        }),
      ).toBeNull()
    }
  })

  it('requires pending identity and current authorized candidates', () => {
    expect(
      resolveGuestPlaceIdentityFollowup({
        rawReply: 'West gallery',
        pending: null,
        currentCandidates: [first],
      }),
    ).toBeNull()
    expect(
      resolveGuestPlaceIdentityFollowup({
        rawReply: 'West gallery',
        pending,
        currentCandidates: [],
      }),
    ).toBeNull()
  })
})
