import { describe, expect, it } from 'vitest'
import { buildVenueSystemPromptParts } from './venue-context'
import { buildGuestVenueGuidePrompt } from './guest-venue-directory'
import { guestCanonicalAliasBody } from './guest-query-whole-sources'
import {
  compileGuestQueryCanonicalSource,
  guestCanonicalEvidenceAuthority,
} from './guest-query-canonical-projection'
import { prepareGuestSubjectEvidence } from './guest-query-subject-evidence'
import type { GuestQuerySource } from './guest-query-source'

const asOf = '2026-10-21T12:00:00.000Z'
const body = 'River Skiff closes at 6 PM. Boarding ends at 5:45 PM.'
const fact = {
  moduleId: 'fact-1',
  revisionId: 'r1',
  publicationId: 'p1',
  publicationOrder: '1',
  version: 1,
  kind: 'OPERATIONAL_FACT' as const,
  audience: 'PUBLIC' as const,
  effectiveFrom: null,
  effectiveUntil: null,
  evidence: [],
  payload: {
    kind: 'OPERATIONAL_FACT' as const,
    label: 'River Skiff hours',
    value: body,
    expiresAt: null,
  },
}
const venue = {
  name: 'Fictional Park',
  category: null,
  description: null,
  guideNotes: null,
  aiGuideNotes: null,
  aiTone: null,
} satisfies Parameters<typeof buildVenueSystemPromptParts>[0]['venue']

describe('fact applicability read compatibility', () => {
  it('keeps full guide and full system text byte-identical for declared and unknown facts', () => {
    const render = (module: typeof fact) => {
      const alias = guestCanonicalAliasBody(module)!
      const directory = {
        incomplete: false,
        places: [],
        knowledge: [
          {
            id: 'alias-1',
            title: alias.title,
            content: alias.content,
            category: 'OPERATIONAL_FACT',
            sourceType: 'UNIVERSAL_CONTENT',
            sourceName: null,
            sourceUrl: null,
          },
        ],
      }
      return {
        guide: buildGuestVenueGuidePrompt(directory, { currentDate: '2026-10-21' }),
        system: buildVenueSystemPromptParts({
          venue,
          relevantPlaces: [],
          userLat: null,
          userLng: null,
          currentDate: '2026-10-21',
          publishedUniversalContent: [module],
        }),
      }
    }
    const unknown = render(fact)
    expect(unknown.guide.prompt).toContain(body)
    expect(unknown.system.dynamicPart + unknown.system.staticPart).toContain(body)
    for (const applicability of [
      { scope: 'VENUE' as const },
      { scope: 'SUBJECTS' as const, subjectModuleIds: ['skiff'], placeIds: [] },
    ]) {
      expect(render({ ...fact, payload: { ...fact.payload, ...{ applicability } } })).toEqual(
        unknown,
      )
    }
  })

  it('manual Knowledge with subject-looking text remains unknown and is retained whole', () => {
    const manual = {
      id: 'manual-1',
      title: 'River Skiff hours',
      content: body,
      category: 'Hours',
      sourceType: 'MANUAL',
      sourceName: null,
      sourceUrl: null,
    }
    const source: GuestQuerySource = {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      version: 'v1',
      asOf,
      coverage: 'COMPLETE',
      includeSecondLayer: false,
      readPath: 'LEGACY',
      directory: { incomplete: false, searchVersion: 'v1', places: [], knowledge: [manual] },
      canonicalModules: { contract: 'published-query-source-v1', modules: [] },
    }
    const compiled = compileGuestQueryCanonicalSource(source)
    expect(
      guestCanonicalEvidenceAuthority(compiled.prepared, source).subjectFactApplicability,
    ).toEqual([])
    const result = prepareGuestSubjectEvidence({
      source,
      compiled,
      keys: ['knowledge:manual-1'],
      mode: 'DETAILS',
    })
    expect(result.knowledge).toEqual([manual])
    expect(result.canonicalSources).toEqual([])
  })
})
