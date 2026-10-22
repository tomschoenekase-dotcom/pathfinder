import { describe, expect, it } from 'vitest'
import type { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'
import type { GuestQuerySource } from './guest-query-source'
import { compileGuestQueryCanonicalSource } from './guest-query-canonical-projection'
import {
  guestCanonicalAliasBody,
  GUEST_EVENT_SEARCH_PROJECTION_CONTRACT,
} from './guest-query-whole-sources'
import { prepareGuestSubjectEvidence } from './guest-query-subject-evidence'
import { prepareGuestQueryEvidence } from './guest-query-evidence'

function source(): GuestQuerySource {
  return {
    tenantId: 'fiction-tenant',
    venueId: 'fiction-venue',
    version: 'v1',
    asOf: '2026-10-21T05:00:00.000Z',
    coverage: 'COMPLETE',
    includeSecondLayer: false,
    readPath: 'LEGACY',
    directory: {
      incomplete: false,
      searchVersion: 'v1',
      knowledge: [],
      places: ['a', 'b'].map((id) => ({
        id,
        name: `Public hall ${id}`,
        type: 'SHOP',
        itemType: null,
        shortDescription: null,
        longDescription: 'Whole public place conditions.',
        lat: null,
        lng: null,
        tags: [],
        areaName: null,
        hours: null,
        photoUrl: null,
        sourceType: 'MANUAL',
        sourceName: null,
        sourceUrl: null,
      })),
    },
    canonicalModules: { contract: 'published-query-source-v1', modules: [] },
  }
}
function append(s: GuestQuerySource, id: string, payload: GeneralizedContentPayload, alias = true) {
  const m = {
    moduleId: id,
    revisionId: `r-${id}`,
    publicationId: `pub-${id}`,
    publicationOrder: String(s.canonicalModules!.modules.length + 1),
    kind: payload.kind,
    version: 1,
    payload,
    audience: 'PUBLIC' as const,
    effectiveFrom: null,
    effectiveUntil: null,
    evidence: [],
  }
  s.canonicalModules!.modules.push(m)
  const body = guestCanonicalAliasBody(m)
  if (alias && body)
    s.directory.knowledge.push({
      id: `alias-${id}`,
      title: body.title,
      category: m.kind,
      content: body.content,
      sourceType: 'UNIVERSAL_CONTENT',
      sourceName: null,
      sourceUrl: null,
      contentModuleId: id,
      contentRevisionId: m.revisionId,
      contentPublicationId: m.publicationId,
    })
  return m
}

function event(endsAt: string | null = null) {
  const s = source()
  const module = append(s, 'talk', {
    kind: 'EVENT',
    name: 'Comet keeper talk',
    description: 'A keeper describes the animal habitat.',
    startsAt: '2026-10-21T10:15:30.123Z',
    endsAt,
    placeId: 'a',
  })
  return { s, module }
}
function selected(s: GuestQuerySource) {
  return prepareGuestSubjectEvidence({
    source: s,
    compiled: compileGuestQueryCanonicalSource(s),
    keys: ['knowledge:alias-talk'],
    mode: 'DETAILS',
  })
}
describe('deterministic event search projection v1', () => {
  it.each([null, '2026-10-21T11:15:30.456Z'])(
    'verifies a named current EVENT with exact UTC millisecond text, end %s',
    async (endsAt) => {
      const { s } = event(endsAt)
      const expected = `A keeper describes the animal habitat.\nStarts: 2026-10-21T10:15:30.123Z\nEnds: ${endsAt ?? 'not specified'}`
      expect(s.directory.knowledge[0]!.content).toBe(expected)
      const result = await prepareGuestQueryEvidence({
        source: s,
        question: 'Tell me about Comet keeper talk',
        interpret: async () => JSON.stringify({ status: 'EVIDENCE_SUBJECTS', refs: ['n0'] }),
      })
      expect(result.status).toBe('LOOKUP_READY')
      if (result.status !== 'LOOKUP_READY') throw new Error('expected current event evidence')
      expect(result.lookup.prompt).toContain('A keeper describes the animal habitat.')
      expect(result.lookup.prompt).toContain('Location: "Public hall a".')
      expect(result.lookup.places.map((place) => place.id)).toEqual(['a'])
      expect(result.lookup.summary.subjectStatus).toContainEqual({
        moduleId: 'talk',
        kind: 'EVENT',
        location: 'RESOLVED_PUBLIC',
      })
      expect(result.lookup.knowledge[0]!.content).toBe(expected)
      expect(
        result.lookup.canonicalSources.some(
          (body) =>
            body.snapshot.payload.kind === 'EVENT' &&
            body.snapshot.payload.startsAt === '2026-10-21T10:15:30.123Z',
        ),
      ).toBe(true)
      expect(result.lookup.summary.eligibilityEvaluated).toBe(false)
      expect(GUEST_EVENT_SEARCH_PROJECTION_CONTRACT).toBe('event-search-projection-utc-ms-v1')
    },
  )
  it('formats the canonical instant, preserves null and empty descriptions, and never guesses an end', () => {
    const { module } = event()
    if (module.payload.kind !== 'EVENT') throw new Error('fixture')
    module.payload.startsAt = '2026-10-21T05:15:30.123-05:00'
    module.payload.description = null
    expect(guestCanonicalAliasBody(module)?.content).toBe(
      'Starts: 2026-10-21T10:15:30.123Z\nEnds: not specified',
    )
    module.payload.description = ''
    expect(guestCanonicalAliasBody(module)?.content).toBe(
      '\nStarts: 2026-10-21T10:15:30.123Z\nEnds: not specified',
    )
  })
  it('rejects legacy session-dependent text rather than normalizing it into authority', () => {
    const { s } = event()
    s.directory.knowledge[0]!.content =
      'A keeper describes the animal habitat.\nStarts: 21/10/2026 10:15:30.123\nEnds: not specified'
    expect(() => selected(s)).toThrow(/exact current canonical alias proof/)
  })
  it.each([
    'title',
    'content',
    'category',
    'sourceType',
    'contentRevisionId',
    'contentPublicationId',
    'contentModuleId',
  ] as const)('rejects forged or stale event alias %s', (field) => {
    const { s } = event()
    s.directory.knowledge[0]![field] = 'forged'
    expect(() => selected(s)).toThrow(/exact current canonical alias proof/)
  })
  it('rejects an alias if its event is withdrawn, no longer effective, or private', () => {
    for (const state of ['withdrawn', 'expired', 'private']) {
      const { s, module } = event()
      if (state === 'withdrawn') s.canonicalModules!.modules = []
      if (state === 'expired')
        s.canonicalModules!.modules[0] = { ...module, effectiveUntil: s.asOf }
      if (state === 'private') Object.assign(module, { audience: 'CLIENT' })
      expect(() => selected(s)).toThrow()
    }
  })
  it('does not invent a place body from a hidden EVENT location or infer live occurrence', () => {
    const { s, module } = event('2026-10-21T11:15:30.456Z')
    if (module.payload.kind !== 'EVENT') throw new Error('fixture')
    module.payload.placeId = 'hidden-place'
    s.asOf = '2026-10-22T05:00:00.000Z'
    const result = selected(s)
    expect(result.places).toEqual([])
    expect(result.prompt).not.toContain('Public hall')
    expect(result.prompt).toContain('Location: not established in this guide; do not guess one.')
    expect(result.summary.subjectStatus).toContainEqual({
      moduleId: 'talk',
      kind: 'EVENT',
      location: 'UNRESOLVED_IN_CURRENT_GUIDE',
    })
    expect(result.canonicalSources.some((body) => body.snapshot.moduleId === 'talk')).toBe(true)
    expect(result.summary.eligibilityEvaluated).toBe(false)
  })
})
