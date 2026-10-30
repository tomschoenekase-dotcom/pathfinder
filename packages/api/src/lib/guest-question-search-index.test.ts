import { describe, expect, it } from 'vitest'

import {
  rankGuestQuestionEvidence,
  guestQuestionSearchIndexStats,
  type GuestEvidenceCandidate,
  revalidateGuestQuestionPlaces,
} from './guest-question-evidence'

function records(count: number): Array<Extract<GuestEvidenceCandidate, { kind: 'knowledge' }>> {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'knowledge' as const,
    id: `record-${i}`,
    chars: 50,
    record: {
      id: `record-${i}`,
      title: `Gallery ${i}`,
      category: 'Exhibits',
      content:
        i === count - 1
          ? 'The amber workshop needs advance booking. Tickets cost 7. Children must bring an adult.'
          : 'A quiet gallery with paintings, benches and a printed map.',
      sourceType: 'MANUAL',
      sourceName: null,
      sourceUrl: null,
    },
  }))
}

describe('versioned question inverted index', () => {
  it('finds governing text beyond 400 and preserves fresh-index ranking on 10000 records', () => {
    const candidates = records(10000)
    const params = {
      query: 'Does the amber workshop need booking and what is the ticket price for children?',
      candidates,
    }
    const fresh = rankGuestQuestionEvidence(params)
    expect(fresh.ranked[0]?.id).toBe('record-9999')
    const cold = rankGuestQuestionEvidence({ ...params, searchVersion: 'test:ten-thousand:v1' })
    const warm = rankGuestQuestionEvidence({ ...params, searchVersion: 'test:ten-thousand:v1' })
    expect(cold).toEqual(fresh)
    expect(warm).toEqual(fresh)
  })

  it('does not reread record bodies on a warm version, and rebuilds a new version', () => {
    const candidates = records(600)
    const final = candidates[candidates.length - 1]!
    let reads = 0
    const record = final.record
    Object.defineProperty(record, 'content', {
      configurable: true,
      get() {
        reads++
        return 'Amber workshop tickets need booking.'
      },
    })
    const params = { query: 'Amber workshop booking?', candidates, searchVersion: 'test:reads:v1' }
    rankGuestQuestionEvidence(params)
    expect(reads).toBeGreaterThan(0)
    reads = 0
    rankGuestQuestionEvidence(params)
    expect(reads).toBe(0)
    rankGuestQuestionEvidence({ ...params, searchVersion: 'test:reads:v2' })
    expect(reads).toBeGreaterThan(0)
  })

  it('bounds retained versions and rebuilds an evicted oldest version', () => {
    const candidates = records(20)
    const params = { query: 'Amber booking?', candidates }
    for (let version = 0; version < 35; version++)
      rankGuestQuestionEvidence({ ...params, searchVersion: `test:lru:${version}` })
    const before = guestQuestionSearchIndexStats()
    expect(before.entries).toBeLessThanOrEqual(32)
    expect(before.estimatedBytes).toBeLessThanOrEqual(128 * 1024 * 1024)
    rankGuestQuestionEvidence({ ...params, searchVersion: 'test:lru:0' })
    expect(guestQuestionSearchIndexStats().builds).toBe(before.builds + 1)
  })

  it('discriminates same-count eligible memberships and keeps deterministic ties', () => {
    const candidates = records(1000)
    const first = rankGuestQuestionEvidence({
      query: 'Amber workshop?',
      candidates,
      searchVersion: 'test:membership',
    })
    expect(first.ranked[0]?.id).toBe('record-999')
    const different = [
      ...candidates.slice(0, -1),
      {
        ...candidates[0]!,
        id: 'replacement',
        record: { ...candidates[0]!.record, id: 'replacement' },
      },
    ]
    expect(
      rankGuestQuestionEvidence({
        query: 'Amber workshop?',
        candidates: different,
        searchVersion: 'test:membership',
      }).ranked,
    ).toEqual([])
    const tied = candidates.slice(0, 6)
    const a = rankGuestQuestionEvidence({ query: 'gallery?', candidates: tied })
    const b = rankGuestQuestionEvidence({
      query: 'gallery?',
      candidates: tied,
      searchVersion: 'test:ties',
    })
    expect(b).toEqual(a)
  })
})

describe('live evidence place hydration', () => {
  it('uses current whole bodies and drops removed places through a scoped query', async () => {
    const calls: Record<string, unknown>[] = []
    const place = {
      id: 'p',
      name: 'Amber hall',
      type: 'ATTRACTION',
      itemType: null,
      shortDescription: 'Current body',
      longDescription: null,
      lat: 0,
      lng: 0,
      tags: [],
      areaName: null,
      hours: null,
      photoUrl: null,
      sourceType: 'MANUAL',
      sourceName: null,
      sourceUrl: null,
    }
    const current = await revalidateGuestQuestionPlaces({
      reader: {
        place: {
          findMany: async (args: Record<string, unknown>) => {
            calls.push(args)
            return [place]
          },
        },
      },
      tenantId: 'tenant-one',
      venueId: 'venue-one',
      includeSecondLayer: false,
      places: [place, { ...place, id: 'withdrawn' }],
    })
    expect(current).toEqual([place])
    expect(calls[0]?.where).toEqual({
      tenantId: 'tenant-one',
      venueId: 'venue-one',
      isActive: true,
      visibility: 'PUBLIC',
      id: { in: ['p', 'withdrawn'] },
    })
    expect(calls[0]?.take).toBe(2)
  })
})
