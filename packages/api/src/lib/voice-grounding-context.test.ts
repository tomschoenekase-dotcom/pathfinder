import { describe, expect, it } from 'vitest'
import type { NativeCoreVisibleState } from '@pathfinder/contracts'
import type { SemanticPlace } from '@pathfinder/db'
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
})
