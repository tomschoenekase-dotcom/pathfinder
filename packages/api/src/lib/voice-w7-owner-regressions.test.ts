// External UNRUN regression drafts: actual native projection + actual identity owners.
// Only diagnostic hash is stubbed; snapshot loading/validation remains a separate integration gate.
import { beforeEach, expect, it, vi } from 'vitest'
import { buildVoiceGroundingContext } from './voice-grounding-context'
const c = vi.hoisted(() => ({ fail: false, mismatch: false, hydrated: 0 }))
vi.mock('@pathfinder/contracts', async (original) => ({
  ...(await original<typeof import('@pathfinder/contracts')>()),
  nativeCoreVisibleStateHash: vi.fn(() => 'diagnostic-hash-not-under-test'),
}))
const knowledge = {
  id: 'ark-policy',
  title: 'Ark',
  category: 'GENERAL',
  content: 'Ark contains a violet prism.',
  sourceType: 'FOUNDER_PROVIDED',
  sourceName: null,
  sourceUrl: null,
  updatedAt: new Date('2026-10-20T00:00:00Z'),
  lastReviewedAt: null,
}
function place(id: string, areaName: string) {
  return {
    id,
    name: 'Ark',
    areaName,
    type: 'PLACE',
    itemType: null,
    shortDescription: null,
    longDescription: `${areaName} private deciding body.`,
    lat: null,
    lng: null,
    tags: [],
    hours: null,
    photoUrl: null,
    sourceType: 'FOUNDER_PROVIDED',
    sourceName: null,
    sourceUrl: null,
    distance: 0,
  }
}
const first = place('ark-first', 'First floor')
const second = place('ark-second', 'Second floor')
vi.mock('./guest-venue-directory', async (original) => ({
  ...(await original<typeof import('./guest-venue-directory')>()),
  loadGuestVenueDirectoryCached: vi.fn(async () => {
    if (c.fail) throw new Error('synthetic full-directory failure')
    return {
      knowledge: [knowledge],
      places: c.mismatch ? [place('outside-native-release', 'Other')] : [first, second],
      incomplete: false,
    }
  }),
}))
vi.mock('./guest-knowledge-retrieval', async (original) => ({
  ...(await original<typeof import('./guest-knowledge-retrieval')>()),
  retrieveGuestKnowledge: vi.fn(async () => ({
    entries: [],
    trace: { retrievalMs: 0, observedSources: [] },
  })),
}))
beforeEach(() => {
  c.fail = false
  c.mismatch = false
  c.hydrated = 0
  vi.clearAllMocks()
})
function reader() {
  return {
    venueKnowledgeEntry: {
      findMany: vi.fn(async () => {
        c.hydrated++
        return [knowledge]
      }),
    },
    place: { findMany: vi.fn(async () => [first]) },
  }
}
function input(path: 'DARK' | 'NATIVE') {
  return {
    reader: reader(),
    tenantId: 't',
    venueId: 'v',
    query: 'Tell me about Ark',
    asOf: new Date('2026-10-20T15:00:00Z'),
    currentDate: '2026-10-20',
    nativeSnapshot: {
      path,
      reason: 'NATIVE_READY',
      releaseId: 'release',
      state: {
        places: [first, second],
        knowledgeEntries: [knowledge],
        generalizedModules: [],
      },
    } as never,
  }
}
it('DARK compatibility content recovers and live-hydrates Ark without false mismatch', async () => {
  const result = await buildVoiceGroundingContext(input('DARK'))
  expect(result.trace.questionEvidence).toMatchObject({
    status: 'READY',
    directoryPath: 'DARK',
    basePath: 'DARK',
  })
  expect(c.hydrated).toBeGreaterThan(0)
  expect(result.sourceIds).toContain('ark-policy')
})
it.each(['LOAD_FAILED', 'PROJECTION_MISMATCH'] as const)(
  'does not certify one native Ark seed unique when full discovery is %s',
  async (failure) => {
    c.fail = failure === 'LOAD_FAILED'
    c.mismatch = failure === 'PROJECTION_MISMATCH'
    const request = input('NATIVE')
    const result = await buildVoiceGroundingContext(request)
    expect(result.trace.questionEvidence.status).toBe(failure)
    expect(result.identityClarificationRequired).toBe(true)
    expect(result.context).toContain('IDENTITY CLARIFICATION DATA')
    expect(result.context).not.toContain('First floor private deciding body.')
    // Initial lexical place read may return one seed, but NATIVE must never do a mutable exact-name expansion.
    expect(request.reader.place.findMany.mock.calls).toHaveLength(1)
  },
)
