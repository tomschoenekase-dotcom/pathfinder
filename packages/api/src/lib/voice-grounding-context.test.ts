import { describe, expect, it, vi } from 'vitest'
import type { NativeCoreVisibleState } from '@pathfinder/contracts'
import type { SemanticPlace } from '@pathfinder/db'
import type { Prisma } from '@prisma/client'
import type { GuestKnowledgeRow } from './guest-knowledge-retrieval'
import { buildVoiceGroundingContext } from './voice-grounding-context'

type Row = GuestKnowledgeRow & {
  tenantId: string
  venueId: string
  visibility: 'PUBLIC' | 'INTERNAL'
  isEnabled: boolean
}
const row = (
  id: string,
  title: string,
  content: string,
  visibility: Row['visibility'] = 'PUBLIC',
): Row => ({
  id,
  title,
  content,
  visibility,
  tenantId: 'tenant',
  venueId: 'venue',
  isEnabled: true,
  category: title,
  sourceType: 'FOUNDER_PROVIDED',
  sourceName: null,
  sourceUrl: null,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  lastReviewedAt: null,
})
const place = (
  input: Partial<SemanticPlace> & Pick<SemanticPlace, 'id' | 'name'>,
): SemanticPlace => ({
  type: 'PLACE',
  itemType: null,
  shortDescription: null,
  longDescription: null,
  lat: null,
  lng: null,
  tags: [],
  areaName: null,
  hours: null,
  photoUrl: null,
  sourceType: 'FOUNDER_PROVIDED',
  sourceName: null,
  sourceUrl: null,
  ...input,
})
function matches(item: Row, where: Record<string, unknown>) {
  if (
    item.tenantId !== where.tenantId ||
    item.venueId !== where.venueId ||
    item.isEnabled !== where.isEnabled
  )
    return false
  if (where.visibility && item.visibility !== where.visibility) return false
  const or = (xs: Record<string, unknown>[]) =>
    xs.some((x) => {
      if ('contentModuleId' in x) return item.contentModuleId == null
      const [field, clause] = Object.entries(x)[0]!
      return String(item[field as keyof Row])
        .toLowerCase()
        .includes(String((clause as { contains: string }).contains).toLowerCase())
    })
  return (
    !Array.isArray(where.AND) ||
    where.AND.every((x) => or((x as { OR: Record<string, unknown>[] }).OR))
  )
}

describe('voice grounding production retrieval parity', () => {
  const duplicateCases = [
    place({ id: 'case-first', name: 'Case 12', areaName: 'East gallery' }),
    place({ id: 'case-second', name: 'Case 12', areaName: 'West gallery' }),
  ]
  const floorRows = [
    { primaryPlaceId: 'case-first', displayName: 'East gallery', floor: { name: 'First floor' } },
    { primaryPlaceId: 'case-second', displayName: 'West gallery', floor: { name: 'Second floor' } },
  ]
  const identityReader = (locations = floorRows, places = duplicateCases) => ({
    venueKnowledgeEntry: { findMany: async () => [] },
    place: { findMany: async () => places },
    venueLocation: { findMany: async () => locations },
  })

  it('requires clarification for duplicate exhibit labels and includes reviewed floor labels', async () => {
    const result = await buildVoiceGroundingContext({
      reader: identityReader() as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about Case 12',
      visitContext: { visitedPlaceIds: ['case-first'], interests: [] },
    })
    expect(result.identityClarificationRequired).toBe(true)
    expect(result.context).toContain('IDENTITY CLARIFICATION DATA')
    expect(result.context).toContain('Case 12 — First floor')
    expect(result.context).toContain('Case 12 — Second floor')
  })

  it('uses only the current query to resolve a named floor and retains unknown-floor ambiguity', async () => {
    const resolved = await buildVoiceGroundingContext({
      reader: identityReader() as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about Case 12 on the first floor',
      visitContext: { visitedPlaceIds: ['case-second'], interests: ['second floor'] },
    })
    expect(resolved.identityClarificationRequired).toBe(false)
    expect(resolved.context).not.toContain('IDENTITY CLARIFICATION DATA')
    expect(resolved.context).toContain('First floor')

    const unknown = await buildVoiceGroundingContext({
      reader: identityReader([floorRows[0]!]) as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about Case 12 on the first floor',
    })
    expect(unknown.identityClarificationRequired).toBe(true)
    expect(unknown.context).toContain('Case 12 — West gallery')
  })

  it('keeps contradictory floor and gallery clues unresolved in voice data', async () => {
    const result = await buildVoiceGroundingContext({
      reader: identityReader() as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about Case 12 on the first floor in West gallery',
    })
    expect(result.identityClarificationRequired).toBe(true)
    expect(result.context).toContain(
      'floor and location clues do not identify a compatible exhibit',
    )
    expect(result.context).not.toContain('Multiple authorized places match')
  })

  it('renders blank reviewed identity labels as unknown', async () => {
    const blankAreaCases = duplicateCases.map((candidate) => ({
      ...candidate,
      areaName: '   ',
    }))
    const result = await buildVoiceGroundingContext({
      reader: identityReader(
        [{ primaryPlaceId: 'case-first', displayName: '   ', floor: { name: '   ' } }],
        blankAreaCases,
      ) as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about Case 12',
    })
    expect(result.context).toContain('Case 12 — location not specified')
    expect(result.context).not.toContain('Case 12 —    ')
  })

  it('prioritizes a deep unique gallery match before the complete-item voice budget', async () => {
    const candidates = Array.from({ length: 64 }, (_, index) =>
      place({
        id: `case-${index}`,
        name: 'Case 12',
        areaName: index === 63 ? 'East gallery' : `West gallery ${index}`,
        shortDescription: index === 63 ? 'EAST TARGET FACT' : 'WRONG WEST FACT',
        longDescription: index === 63 ? 'x'.repeat(11_850) : null,
      }),
    )
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: {
          findMany: async (args: Prisma.PlaceFindManyArgs) =>
            args.where && 'name' in args.where ? candidates : [candidates[0]!],
        },
        venueLocation: {
          findMany: async () =>
            candidates.map((candidate, index) => ({
              primaryPlaceId: candidate.id,
              displayName: index === 63 ? 'East gallery' : `West gallery ${index}`,
              floor: { name: 'First floor' },
            })),
        },
      } as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about Case 12 in East gallery',
    })
    expect(result.identityClarificationRequired).toBe(false)
    expect(result.context).toContain('EAST TARGET FACT')
    expect(result.context).not.toContain('WRONG WEST FACT')
    expect(result.sourceIds).toContain('place:case-63')
  })

  it('does not replace an oversized resolved gallery with incompatible duplicate facts', async () => {
    const candidates = [
      place({
        id: 'case-west',
        name: 'Case 12',
        areaName: 'West gallery',
        shortDescription: 'WRONG WEST FACT',
      }),
      place({
        id: 'case-east',
        name: 'Case 12',
        areaName: 'East gallery',
        longDescription: `EAST TARGET FACT ${'x'.repeat(12_000)}`,
      }),
    ]
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: { findMany: async () => candidates },
        venueLocation: {
          findMany: async () => [
            { primaryPlaceId: 'case-west', displayName: 'West gallery', floor: null },
            { primaryPlaceId: 'case-east', displayName: 'East gallery', floor: null },
          ],
        },
      } as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about Case 12 in East gallery',
    })
    expect(result.identityClarificationRequired).toBe(false)
    expect(result.context).not.toContain('WRONG WEST FACT')
    expect(result.sourceIds).not.toContain('place:case-east')
    expect(result.omittedSourceIds).toContain('place:case-east')
  })

  it('expands an explicitly named label beyond the initial ranking before resolving its floor', async () => {
    const third = place({ id: 'case-third', name: 'Case 12', areaName: 'Annex' })
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: {
          findMany: async (args: Prisma.PlaceFindManyArgs) =>
            args.where && 'name' in args.where ? [...duplicateCases, third] : duplicateCases,
        },
        venueLocation: {
          findMany: async () => [
            ...floorRows,
            {
              primaryPlaceId: 'case-third',
              displayName: 'Annex',
              floor: { name: 'First floor' },
            },
          ],
        },
      } as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about Case 12 on the first floor',
    })
    expect(result.identityClarificationRequired).toBe(true)
    expect(result.context).toContain(
      'Case 12 — First floor · East gallery; Case 12 — First floor · Annex',
    )
  })

  it('keeps clarification required when exact-label discovery reaches its cap', async () => {
    const candidates = Array.from({ length: 65 }, (_, index) =>
      place({ id: `case-${index}`, name: 'Case 12', areaName: `Gallery ${index}` }),
    )
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: {
          findMany: async (args: Prisma.PlaceFindManyArgs) =>
            args.where && 'name' in args.where ? candidates : [candidates[0]!, candidates[1]!],
        },
        venueLocation: {
          findMany: async () =>
            candidates.map((candidate, index) => ({
              primaryPlaceId: candidate.id,
              displayName: candidate.areaName!,
              floor: { name: index === 0 ? 'First floor' : 'Second floor' },
            })),
        },
      } as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about Case 12 on the first floor',
    })
    expect(result.identityClarificationRequired).toBe(true)
    expect(result.context).toContain('Candidate discovery')
    expect(result.context).toContain('bounded limit')
  })

  it('does not force identity clarification for comparison requests', async () => {
    const result = await buildVoiceGroundingContext({
      reader: identityReader() as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Compare Case 12 on both floors',
    })
    expect(result.identityClarificationRequired).toBe(false)
  })

  it('never lets a filtered private duplicate create or satisfy identity ambiguity', async () => {
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: {
          findMany: async (args: Prisma.PlaceFindManyArgs) => {
            expect(args.where).toMatchObject({ visibility: 'PUBLIC', isActive: true })
            return [duplicateCases[0]]
          },
        },
        venueLocation: { findMany: vi.fn() },
      } as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about Case 12',
    })
    expect(result.identityClarificationRequired).toBe(false)
    expect(result.context).not.toContain('Second floor')
    expect(result.sourceIds).not.toContain('place:case-second')
  })

  it('retains the identity flag and header when ordinary grounding fills the budget', async () => {
    const result = await buildVoiceGroundingContext({
      reader: {
        ...identityReader(),
        venueKnowledgeEntry: {
          findMany: async () => [row('large', 'Large source', 'x'.repeat(11_900))],
        },
      } as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about Case 12 large source',
    })
    expect(result.identityClarificationRequired).toBe(true)
    expect(result.context.startsWith('IDENTITY CLARIFICATION DATA')).toBe(true)
    expect(result.context.length).toBeLessThanOrEqual(12_000)
  })

  it('accounts for the header separator at the exact context boundary', async () => {
    const header =
      'IDENTITY CLARIFICATION DATA: Multiple authorized places match Case 12. Candidates: Case 12 — First floor · East gallery; Case 12 — Second floor · West gallery'
    const prefix = '[PLACE: Case 12]\nPLACE · First floor · East gallery · '
    const edgeCases = [
      place({
        ...duplicateCases[0]!,
        longDescription: 'x'.repeat(12_000 - header.length - 2 - prefix.length),
      }),
      duplicateCases[1]!,
    ]
    const result = await buildVoiceGroundingContext({
      reader: {
        ...identityReader(floorRows, edgeCases),
      } as never,
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about Case 12 edge source',
    })
    expect(result.context.length).toBe(12_000)
    expect(result.sourceIds).toContain('place:case-first')
    expect(result.sourceIds).not.toContain('place:case-second')
  })

  it('finds bounded public facts for voice while excluding private and wrong-scope distractors', async () => {
    const corpus = [
      row('bathroom', 'Accessible bathrooms', 'Accessible bathrooms are beside the east lift.'),
      row(
        'history',
        'Obscure lighthouse history',
        `${'Background. '.repeat(300)} The Fresnel lens arrived in 1912.`,
      ),
      row('family', 'Family suggestions', 'Families can try the tide-pool lab after lunch.'),
      row('private', 'Internal bathroom code', 'Staff code 9911.', 'INTERNAL'),
      { ...row('other', 'Other bathroom', 'Wrong venue.'), venueId: 'other' },
    ]
    const reader = {
      venueKnowledgeEntry: {
        findMany: async (args: Record<string, unknown>) =>
          corpus
            .filter((x) => matches(x, args.where as Record<string, unknown>))
            .slice(0, Number(args.take)),
      },
    }
    for (const [query, expected] of [
      ['Where is an accessible bathroom?', 'bathroom'],
      ['When did the Fresnel lens arrive in the lighthouse?', 'history'],
      ['What should my family do after lunch?', 'family'],
    ] as const) {
      const result = await buildVoiceGroundingContext({
        reader,
        tenantId: 'tenant',
        venueId: 'venue',
        query,
      })
      expect(result.sourceIds).toContain(expected)
      expect(result.sourceIds).not.toContain('private')
      expect(result.context.length).toBeLessThanOrEqual(12_000)
      expect(result.provider).toEqual({ called: false, qualityVerified: false })
      expect(result.measurements.providerLatencyMs).toBeNull()
    }
  })

  it('returns honest empty grounded context for a missing fact', async () => {
    const result = await buildVoiceGroundingContext({
      reader: { venueKnowledgeEntry: { findMany: async () => [] } },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'What is the secret tunnel schedule?',
    })
    expect(result).toMatchObject({
      context: '',
      sourceIds: [],
      provider: { called: false, qualityVerified: false },
    })
  })

  it('adds only scoped active places and currently effective published updates', async () => {
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: {
          findMany: async (args) => {
            expect(args.where).toMatchObject({
              tenantId: 'tenant',
              venueId: 'venue',
              visibility: 'PUBLIC',
              isActive: true,
            })
            return [
              place({
                id: 'lift',
                name: 'East lift',
                type: 'ACCESSIBILITY',
                areaName: 'Atrium',
                shortDescription: 'Step-free access',
              }),
            ]
          },
        },
        operationalUpdate: {
          findMany: async (args) => {
            expect(args.where).toMatchObject({
              tenantId: 'tenant',
              venueId: 'venue',
              status: 'PUBLISHED',
              isActive: true,
            })
            return [{ id: 'closure', title: 'Lift closure', body: 'Use the west lift today.' }]
          },
        },
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Is the lift open?',
      asOf: new Date('2026-09-07T12:00:00Z'),
    })
    expect(result.context).toContain('[PLACE: East lift]')
    expect(result.context).toContain('[CURRENT UPDATE: Lift closure]')
    expect(result.sourceIds).toEqual(['update:closure', 'place:lift'])
    expect(result.omittedSourceIds).toEqual([])
  })

  it('runs a scoped place lookup for a two-character WC query', async () => {
    let observedWhere: unknown
    await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: {
          findMany: async (args) => {
            observedWhere = args.where
            return []
          },
        },
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'WC',
    })
    expect(observedWhere).toMatchObject({
      tenantId: 'tenant',
      venueId: 'venue',
      OR: expect.arrayContaining([{ name: { contains: 'wc', mode: 'insensitive' } }]),
    })
  })

  it.each(['WC', '厕所在哪里', 'トイレはどこ'])(
    'retrieves English place names for %s without embeddings',
    async (query) => {
      const result = await buildVoiceGroundingContext({
        reader: {
          venueKnowledgeEntry: { findMany: async () => [] },
          place: {
            findMany: async (args) => {
              expect(args.where).toMatchObject({
                tenantId: 'tenant',
                venueId: 'venue',
                visibility: 'PUBLIC',
                isActive: true,
              })
              const clauses = args.where!.OR as Array<Record<string, { contains: string }>>
              const candidate = place({
                id: 'east-restroom',
                name: 'East restroom',
                shortDescription: 'Beside the lift.',
              })
              return clauses.some((clause) =>
                Object.entries(clause).some(([field, filter]) =>
                  String(candidate[field as keyof SemanticPlace] ?? '')
                    .toLowerCase()
                    .includes(filter.contains),
                ),
              )
                ? [candidate]
                : []
            },
          },
        },
        tenantId: 'tenant',
        venueId: 'venue',
        query,
      })
      expect(result.sourceIds).toContain('place:east-restroom')
      expect(result.context).toContain('East restroom')
      expect(result.provider.called).toBe(false)
    },
  )

  it('retrieves explicitly preferred exhibits for a broad recommendation without inventing visited status', async () => {
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: {
          findMany: async (args) => {
            const clauses = args.where!.OR as Array<Record<string, { contains: string }>>
            expect(clauses).toContainEqual({ name: { contains: 'trains', mode: 'insensitive' } })
            expect(args.where).toMatchObject({
              tenantId: 'tenant',
              venueId: 'venue',
              visibility: 'PUBLIC',
            })
            return [place({ id: 'train-hall', name: 'Train Hall' })]
          },
        },
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'What should I see next?',
      visitContext: { visitedPlaceIds: [], interests: ['trains'] },
    })
    expect(result.context).toContain('Train Hall')
    expect(result.visitContext?.visitedPlaces).toEqual([])
    expect(result.provider.called).toBe(false)
  })

  it('over-fetches past visited recommendations and retains visited labels only as preference context', async () => {
    const places = Array.from({ length: 9 }, (_, index) =>
      place({ id: `place-${index + 1}`, name: `Gallery ${index + 1}` }),
    )
    const visitedPlaceIds = places.slice(0, 8).map(({ id }) => id)
    const findMany = vi.fn(async (args: Prisma.PlaceFindManyArgs) => {
      void args
      return places
    })
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: { findMany },
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'What should I see next?',
      visitContext: { visitedPlaceIds, interests: ['galleries'] },
    })

    expect(findMany.mock.calls[0]?.[0]).toMatchObject({ take: 16 })
    expect(result.context).toContain('[PLACE: Gallery 9]')
    expect(result.sourceIds).toContain('place:place-9')
    for (let index = 1; index <= 8; index += 1) {
      expect(result.context).not.toContain(`[PLACE: Gallery ${index}]`)
      expect(result.sourceIds).not.toContain(`place:place-${index}`)
    }
    expect(result.visitContext?.visitedPlaces).toHaveLength(8)
    expect(result.visitContext?.visitedPlaces.map(({ name }) => name)).toContain('Gallery 1')
    expect(result.context).toContain('Recommend only eligible PLACE choices included below')
  })

  it('keeps the final recommendation place budget at eight despite twenty unknown visited IDs', async () => {
    const places = Array.from({ length: 28 }, (_, index) =>
      place({ id: `eligible-${index + 1}`, name: `Eligible Gallery ${index + 1}` }),
    )
    const findMany = vi.fn(async (args: Prisma.PlaceFindManyArgs) => {
      void args
      return places
    })
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: { findMany },
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'What should I see next?',
      visitContext: {
        visitedPlaceIds: Array.from({ length: 20 }, (_, index) => `unknown-${index + 1}`),
        interests: [],
      },
    })

    expect(findMany.mock.calls[0]?.[0]).toMatchObject({ take: 28 })
    expect(result.sourceIds.filter((sourceId) => sourceId.startsWith('place:'))).toHaveLength(8)
    expect(result.context.match(/\[PLACE:/gu)).toHaveLength(8)
    expect(result.sourceIds).not.toContain('place:eligible-9')
  })

  it('honestly leaves no place recommendation when every authorized choice was visited', async () => {
    const places = [
      place({ id: 'visited-1', name: 'Visited One' }),
      place({ id: 'visited-2', name: 'Visited Two' }),
    ]
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [row('safety', 'Next', 'Use the lift.')] },
        place: { findMany: async () => places },
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'What should I see next?',
      visitContext: { visitedPlaceIds: ['visited-1', 'visited-2'], interests: [] },
    })

    expect(result.context).not.toContain('[PLACE:')
    expect(result.sourceIds).not.toContain('place:visited-1')
    expect(result.sourceIds).not.toContain('place:visited-2')
    expect(result.context).toContain(
      'If no new eligible PLACE choice is available, say so honestly',
    )
    expect(result.context).toContain('[KNOWLEDGE: Next]')
    expect(result.visitContext?.visitedPlaces).toHaveLength(2)
  })

  it('retains visited place facts for an explicit revisit instead of applying next-choice filtering', async () => {
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: {
          findMany: async () => [
            place({ id: 'train-hall', name: 'Train Hall', hours: 'Open until 5 PM' }),
          ],
        },
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Take me back to Train Hall',
      visitContext: { visitedPlaceIds: ['train-hall'], interests: [] },
    })

    expect(result.context).toContain('[PLACE: Train Hall]')
    expect(result.context).toContain('Open until 5 PM')
    expect(result.sourceIds).toContain('place:train-hall')
    expect(result.context).not.toContain('RECOMMENDATION SCOPE')
  })

  it('never emits a partial item or claims an omitted oversized source was included', async () => {
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: {
          findMany: async () => [row('small', 'Capacity', 'Capacity is 137.')],
        },
        place: {
          findMany: async () => [
            place({ id: 'oversized', name: 'Oversized', longDescription: 'x'.repeat(13_000) }),
          ],
        },
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'What is the capacity oversized?',
    })
    expect(result.context).toContain('Capacity is 137')
    expect(result.context).not.toContain('x'.repeat(100))
    expect(result.sourceIds).toEqual(['small'])
    expect(result.omittedSourceIds).toContain('place:oversized')
  })

  it('reports the effective legacy fallback separately from native snapshot eligibility', async () => {
    const known = row('known', 'Known capacity', 'Legacy capacity is 120.')
    const missing = row('missing', 'Missing policy', 'Legacy policy remains selected.')
    const state = {
      venue: {
        name: 'Native Venue',
        slug: 'native-venue',
        description: null,
        guideNotes: null,
        aiGuideNotes: null,
        aiFeaturedPlaceId: null,
        aiTone: 'FRIENDLY',
        tonePreset: 'friendly',
        tonePresetVersion: 1,
        aiGuideName: null,
        chatTheme: 'default',
        chatAccentColor: null,
        chatFont: 'jakarta',
        chatLogoUrl: null,
        chatBannerUrl: null,
        category: null,
        guideMode: 'location_aware',
        defaultCenterLat: null,
        defaultCenterLng: null,
        geoBoundary: null,
        isActive: true,
      },
      venueBotConfiguration: {
        presentationMode: 'CLASSIC',
        personalityMode: 'PRESET',
        tonePreset: 'friendly',
        tonePresetVersion: 1,
        responseDepth: 'BALANCED',
        personalityProfileId: null,
        characterKey: null,
        customCharacterId: null,
        publicDisplayName: null,
        greeting: null,
        voiceProfileId: null,
      },
      places: [],
      knowledgeEntries: [
        {
          id: known.id,
          title: 'Known capacity',
          category: 'Known capacity',
          content: 'Native capacity is 137.',
          sourceType: 'FOUNDER',
          sourceName: null,
          sourceUrl: null,
          isEnabled: true,
          authorship: 'HUMAN',
          importedAt: null,
          humanConfirmedAt: null,
          humanConfirmedBy: null,
          lastReviewedAt: null,
          lastReviewedBy: null,
          sourcePackageId: null,
        },
      ],
      generalizedModules: [],
    } as unknown as NativeCoreVisibleState

    const result = await buildVoiceGroundingContext({
      reader: { venueKnowledgeEntry: { findMany: async () => [known, missing] } },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'What is the known capacity and missing policy?',
      nativeSnapshot: {
        path: 'NATIVE',
        reason: 'NATIVE_READY',
        releaseId: '11111111-1111-4111-8111-111111111111',
        state,
      },
    })

    expect(result.nativeProjection).toMatchObject({
      path: 'NATIVE',
      effectiveContentPath: 'LEGACY',
      reason: 'NATIVE_READY',
    })
    expect(result.context).toContain('Legacy capacity is 120.')
    expect(result.context).not.toContain('Native capacity is 137.')
  })

  it('adds reviewed editorial media only for an included public place with exact review provenance', async () => {
    const mediaFindMany = vi.fn().mockResolvedValue([
      {
        id: 'derivative-1',
        approvedReviewSequence: 7,
        createdAt: new Date('2026-09-08T00:00:00Z'),
        asset: {
          altText: 'A painted tide map above the entry',
          caption: 'Editorial caption retained after review.',
          sourceName: 'Museum archive',
          sourceUrl: 'https://untrusted.example/raw-asset',
          placeLinks: [{ placeId: 'tide-hall' }],
          reviews: [{ sequence: 7, action: 'APPROVE_CONTENT_USE', rightsBasis: 'LICENSED' }],
        },
      },
    ])
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: { findMany: async () => [place({ id: 'tide-hall', name: 'Tide Hall' })] },
        venueMediaDerivative: { findMany: mediaFindMany } as never,
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Where is the tide hall?',
      mediaPolicy: { venueSlug: 'tide-venue', showPhotos: true, showLinks: false },
    })
    expect(result.context).toContain(
      '[APPROVED MEDIA DESCRIPTION · EDITORIAL CAPTION FOR Tide Hall]',
    )
    expect(result.context).toContain('A painted tide map above the entry')
    expect(result.context).toContain('Editorial caption retained after review.')
    expect(result.context).toContain('SOURCE CREDIT: Museum archive')
    expect(result.context).not.toContain('https://untrusted.example')
    expect(result.sourceIds).toContain('media:derivative-1:review:7')
    expect(mediaFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant',
          venueId: 'venue',
          asset: expect.objectContaining({
            placeLinks: expect.objectContaining({
              some: expect.objectContaining({
                place: {
                  tenantId: 'tenant',
                  venueId: 'venue',
                  visibility: 'PUBLIC',
                  isActive: true,
                },
              }),
            }),
          }),
        }),
      }),
    )
  })

  it('does not read optional media when photo policy is disabled or no public place was included', async () => {
    const disabledFindMany = vi.fn()
    await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: { findMany: async () => [place({ id: 'lift', name: 'East lift' })] },
        venueMediaDerivative: { findMany: disabledFindMany } as never,
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Where is the lift?',
      mediaPolicy: { venueSlug: 'venue', showPhotos: false, showLinks: false },
    })
    expect(disabledFindMany).not.toHaveBeenCalled()

    const noPlaceFindMany = vi.fn()
    const noPlace = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: { findMany: async () => [] },
        venueMediaDerivative: { findMany: noPlaceFindMany } as never,
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Where is the lift?',
      mediaPolicy: { venueSlug: 'venue', showPhotos: true, showLinks: false },
    })
    expect(noPlace.sourceIds).not.toContain(expect.stringMatching(/^media:/u))
    expect(noPlaceFindMany).not.toHaveBeenCalled()
  })

  it('omits an over-budget editorial description without truncating it or removing core grounding', async () => {
    const editorialCaption = 'reviewed-caption '.repeat(80)
    const mediaFindMany = vi.fn().mockResolvedValue([
      {
        id: 'derivative-budget',
        approvedReviewSequence: 3,
        createdAt: new Date(),
        asset: {
          altText: 'Reviewed tide map',
          caption: editorialCaption,
          sourceName: 'Archive',
          sourceUrl: null,
          placeLinks: [{ placeId: 'tide-hall' }],
          reviews: [{ sequence: 3, action: 'APPROVE_CONTENT_USE', rightsBasis: 'OWNED' }],
        },
      },
    ])
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: {
          findMany: async () => [
            place({ id: 'tide-hall', name: 'Tide Hall', longDescription: 'x'.repeat(10_950) }),
          ],
        },
        venueMediaDerivative: { findMany: mediaFindMany } as never,
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Tell me about the tide hall context reserve',
      mediaPolicy: { venueSlug: 'venue', showPhotos: true, showLinks: false },
    })
    expect(result.context).toContain('[PLACE: Tide Hall]')
    expect(result.context).not.toContain(editorialCaption)
    expect(result.sourceIds).not.toContain('media:derivative-budget:review:3')
    expect(result.omittedSourceIds).toContain('media:derivative-budget:review:3')
    expect(result.context.length).toBeLessThanOrEqual(12_000)
  })

  it('keeps core grounding when the optional approved-media read fails', async () => {
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: { findMany: async () => [place({ id: 'lift', name: 'East lift' })] },
        venueMediaDerivative: {
          findMany: async () => {
            throw new Error('optional read unavailable')
          },
        } as never,
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Where is the lift?',
      mediaPolicy: { venueSlug: 'venue', showPhotos: true, showLinks: false },
    })
    expect(result.context).toContain('[PLACE: East lift]')
    expect(result.sourceIds).toEqual(['place:lift'])
  })

  it('skips unillustrated early places and deduplicates a shared approved derivative before applying the media cap', async () => {
    const mediaFindMany = vi.fn().mockResolvedValue([
      {
        id: 'shared-derivative',
        approvedReviewSequence: 4,
        createdAt: new Date(),
        asset: {
          altText: 'Shared approved caption',
          caption: null,
          sourceName: 'Archive',
          sourceUrl: null,
          placeLinks: [{ placeId: 'place-2' }, { placeId: 'place-3' }],
          reviews: [{ sequence: 4, action: 'APPROVE_CONTENT_USE', rightsBasis: 'OWNED' }],
        },
      },
      {
        id: 'fourth-derivative',
        approvedReviewSequence: 5,
        createdAt: new Date(),
        asset: {
          altText: 'Fourth place reviewed caption',
          caption: null,
          sourceName: 'Archive',
          sourceUrl: null,
          placeLinks: [{ placeId: 'place-4' }],
          reviews: [{ sequence: 5, action: 'APPROVE_CONTENT_USE', rightsBasis: 'OWNED' }],
        },
      },
    ])
    const result = await buildVoiceGroundingContext({
      reader: {
        venueKnowledgeEntry: { findMany: async () => [] },
        place: {
          findMany: async () => [
            place({ id: 'place-1', name: 'First place' }),
            place({ id: 'place-2', name: 'Second place' }),
            place({ id: 'place-3', name: 'Third place' }),
            place({ id: 'place-4', name: 'Fourth place' }),
          ],
        },
        venueMediaDerivative: { findMany: mediaFindMany } as never,
      },
      tenantId: 'tenant',
      venueId: 'venue',
      query: 'Where are the places?',
      mediaPolicy: { venueSlug: 'venue', showPhotos: true, showLinks: false },
    })
    expect(result.sourceIds.filter((id) => id.startsWith('media:'))).toEqual([
      'media:shared-derivative:review:4',
      'media:fourth-derivative:review:5',
    ])
    expect(result.context).toContain('EDITORIAL CAPTION FOR Fourth place')
    expect(result.context.match(/Shared approved caption/gu)).toHaveLength(1)
  })
})
