// Voice question-evidence integration regressions.
import { beforeEach, expect, it, vi } from 'vitest'
import { buildVoiceGroundingContext } from './voice-grounding-context'
import type { GuestVenueDirectory } from './guest-venue-directory'
import type { GuestKnowledgeReader } from './guest-knowledge-retrieval'
const control = vi.hoisted(() => ({
  native: false,
  withdrawn: false,
  directory: {
    knowledge: [] as GuestVenueDirectory['knowledge'],
    places: [] as GuestVenueDirectory['places'],
    incomplete: false,
  },
}))
vi.mock('./guest-venue-directory', async (original) => ({
  ...(await original<typeof import('./guest-venue-directory')>()),
  loadGuestVenueDirectoryCached: vi.fn(async () => control.directory),
}))
vi.mock('./guest-knowledge-retrieval', async (original) => ({
  ...(await original<typeof import('./guest-knowledge-retrieval')>()),
  retrieveGuestKnowledge: vi.fn(async () => ({
    entries: [],
    trace: { retrievalMs: 0, observedSources: [] },
  })),
}))
vi.mock('@pathfinder/db', async (original) => ({
  ...(await original<typeof import('@pathfinder/db')>()),
  applyNativeGuestContentRead: vi.fn(
    (input: Parameters<typeof import('@pathfinder/db').applyNativeGuestContentRead>[0]) =>
      control.native
        ? {
            path: 'NATIVE',
            places: [],
            knowledgeEntries: input.legacyKnowledgeEntries.length
              ? [
                  {
                    id: 'native-ark',
                    title: 'Ark',
                    category: 'GENERAL',
                    content: 'Ark contains an amber prism.',
                    sourceType: 'FOUNDER_PROVIDED',
                    sourceName: null,
                    sourceUrl: null,
                    distance: 0,
                  },
                ]
              : [],
          }
        : {
            path: 'LEGACY',
            places: input.legacyPlaces,
            knowledgeEntries: input.legacyKnowledgeEntries,
          },
  ),
}))
const source = {
  id: 'legacy-ark',
  title: 'Ark',
  category: 'GENERAL',
  content: 'Ark contains a violet prism. A visitor needs a companion.',
  sourceType: 'FOUNDER_PROVIDED',
  sourceName: null,
  sourceUrl: null,
  updatedAt: new Date('2026-10-20T00:00:00Z'),
  lastReviewedAt: null,
}
beforeEach(() => {
  control.native = false
  control.withdrawn = false
  control.directory = { knowledge: [source], places: [], incomplete: false }
  vi.clearAllMocks()
})
const query =
  'Consider spectacular architecture sculpture displays demonstrations workshops collections and Ark'
function reader() {
  return {
    venueKnowledgeEntry: {
      findMany: vi.fn(
        async (args: Parameters<GuestKnowledgeReader['venueKnowledgeEntry']['findMany']>[0]) => {
          expect(args.where).toMatchObject({
            tenantId: 't-w7',
            venueId: 'v-w7',
            visibility: 'PUBLIC',
            isEnabled: true,
            sourceType: { not: 'SOURCE_CONNECTION' },
          })
          return control.withdrawn ? [] : [source]
        },
      ),
    },
    place: { findMany: vi.fn(async () => []) },
  }
}
function args(r = reader()) {
  return {
    reader: r,
    tenantId: 't-w7',
    venueId: 'v-w7',
    query,
    asOf: new Date('2026-10-20T05:30:00Z'),
    currentDate: '2026-10-19',
  }
}
it('recovers Ark whole knowledge evidence when initial lexical retrieval misses the short name', async () => {
  const result = await buildVoiceGroundingContext(args())
  expect(result.context).toContain('A visitor needs a companion.')
  expect(result.sourceIds).toContain('legacy-ark')
  expect(result.trace.questionEvidence.status).toBe('READY')
})
it('drops withdrawn LEGACY question evidence on live hydration', async () => {
  control.withdrawn = true
  const result = await buildVoiceGroundingContext(args())
  expect(result.sourceIds).not.toContain('legacy-ark')
})
it('selects a native-only fact from the projected whole directory and never hydrates legacy rows', async () => {
  control.native = true
  const r = reader()
  const result = await buildVoiceGroundingContext({
    ...args(r),
    query: 'Where is the amber prism in Ark?',
    nativeSnapshot: {
      path: 'NATIVE',
      reason: 'NATIVE_READY',
      releaseId: 'release-w7',
      state: null,
    } as never,
  })
  expect(result.context).toContain('amber prism')
  expect(result.context).not.toContain('violet prism')
  expect(result.sourceIds).toContain('native-ark')
  expect(r.venueKnowledgeEntry.findMany).not.toHaveBeenCalled()
  // Controlled projection mock checks orchestration only; real snapshot authority remains a separate gate.
})
it('keeps no-place readers on an honest compatibility path', async () => {
  const { loadGuestVenueDirectoryCached } = await import('./guest-venue-directory')
  const r = reader()
  const result = await buildVoiceGroundingContext({
    ...args(),
    reader: { venueKnowledgeEntry: r.venueKnowledgeEntry },
  })
  expect(loadGuestVenueDirectoryCached).not.toHaveBeenCalled()
  expect(result.trace.questionEvidence.status).toBe('UNAVAILABLE_READER')
  expect(result.provider.called).toBe(false)
})
