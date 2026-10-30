import { describe, expect, it } from 'vitest'
import { loadGuestVenueDirectory, buildGuestVenueGuidePrompt } from './guest-venue-directory'
import { previewVenuePackageGuide } from './venue-package-guide-preview'

const date = '2026-10-24'
const provenance = { sourceType: 'MANUAL', contentOrigin: 'AI_GENERATED' }
function fixture() {
  return {
    schemaVersion: 3,
    places: {
      create: [
        {
          itemKey: '00000000-0000-4000-8000-000000000099',
          provenance,
          value: { name: 'Cloud Lantern Pavilion', type: 'ATTRACTION', hours: 'Unconfirmed' },
        },
      ],
      update: [],
      delete: [],
    },
    knowledgeEntries: {
      create: Array.from({ length: 24 }, (_, index) => ({
        itemKey: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        provenance,
        value: {
          title: `Cloud Lantern topic ${String(index).padStart(2, '0')}`,
          category: 'GENERAL',
          content: 'x'.repeat(4900),
          isEnabled: true,
        },
      })),
      update: [],
      delete: [],
    },
  }
}

describe('offline production guide preview', () => {
  it('measures immediately below, at and above the actual production boundary', () => {
    const input = fixture()
    const initial = previewVenuePackageGuide(input, date).default.fullGuideRenderedChars
    // Tune only fictional body content; production renderer remains unchanged.
    const entry = input.knowledgeEntries.create[0]!.value
    const target = 119_999
    entry.content = 'x'.repeat(entry.content.length + target - initial)
    const below = previewVenuePackageGuide(input, date)
    expect(below.default).toMatchObject({
      mode: 'FULL',
      renderedChars: 119_999,
      fullGuideRenderedChars: 119_999,
      rendererTruncated: false,
      maxFullChars: 120_000,
    })
    expect(below.evidence.mode).toBe('DIRECTORY')
    entry.content += 'x'
    expect(previewVenuePackageGuide(input, date).default.mode).toBe('FULL')
    entry.content += 'x'
    const above = previewVenuePackageGuide(input, date)
    expect(above.default).toMatchObject({ mode: 'DIRECTORY', fullGuideRenderedChars: 120_001 })
    expect(above.default.renderedChars).toBeLessThan(120_000)
  })

  it.each(['places', 'knowledgeEntries'] as const)(
    'refuses %s deletes because live rows are needed',
    (kind) => {
      const original = fixture()
      const input = {
        ...original,
        [kind]: {
          ...original[kind],
          delete: [
            {
              itemKey: '00000000-0000-4000-8000-000000000098',
              provenance,
              id: 'clantern000000000000000001',
            },
          ],
        },
      }
      expect(() => previewVenuePackageGuide(input, date)).toThrow('needs live rows')
    },
  )

  it('refuses a valid update package', () => {
    const original = fixture()
    const input = {
      ...original,
      knowledgeEntries: {
        ...original.knowledgeEntries,
        update: [
          {
            itemKey: '00000000-0000-4000-8000-000000000098',
            provenance,
            id: 'clantern000000000000000001',
            value: {
              title: 'Cloud Lantern policy',
              category: 'GENERAL',
              content: 'Unconfirmed.',
              isEnabled: true,
            },
          },
        ],
      },
    }
    expect(() => previewVenuePackageGuide(input, date)).toThrow('needs live rows')
  })

  it('validates package and date, excludes disabled knowledge and discloses assumptions', () => {
    expect(() => previewVenuePackageGuide({}, date)).toThrow()
    expect(() => previewVenuePackageGuide(fixture(), '2026-02-30')).toThrow('valid YYYY-MM-DD')
    const input = fixture()
    input.knowledgeEntries.create[0]!.value.isEnabled = false
    const result = previewVenuePackageGuide(input, date)
    expect(result.counts).toEqual({ places: 1, knowledge: 23 })
    expect(result.assumptions.join(' ')).toContain('no live authority')
    expect(result.scope).toBe('CREATE_ONLY_PACKAGE_PREVIEW')
  })
})

describe('create-only place activity parity', () => {
  it('rejects create-time isActive/visibility, so no inactive place can reach the projection', () => {
    // The create value schema (PlaceInput from @pathfinder/contracts/venue-package) is strict and has no
    // isActive/visibility; import writes neither on create (DB default active, PUBLIC). Production
    // guestPlaceScope (isActive:true) therefore cannot diverge from the preview for create-only packages.
    for (const extra of [{ isActive: false }, { visibility: 'SECOND_LAYER' }]) {
      const input = fixture()
      Object.assign(input.places.create[0]!.value, extra)
      expect(() => previewVenuePackageGuide(input, date)).toThrow(/Unrecognized key/)
    }
  })
})

describe('connected-source production eligibility', () => {
  it('excludes known ineligible knowledge consistently with the actual production loader', async () => {
    const original = fixture()
    const operation = {
      ...original.knowledgeEntries.create[0]!,
      provenance: { ...provenance, sourceType: 'SOURCE_CONNECTION' },
    }
    const input = {
      ...original,
      places: { create: [], update: [], delete: [] },
      knowledgeEntries: { create: [operation], update: [], delete: [] },
    }
    const preview = previewVenuePackageGuide(input, date)
    const directory = await loadGuestVenueDirectory({
      reader: {
        venueKnowledgeEntry: {
          findMany: async () => [
            {
              id: operation.itemKey,
              ...operation.value,
              sourceType: 'SOURCE_CONNECTION',
              sourceName: null,
              sourceUrl: null,
            },
          ],
        },
        place: { findMany: async () => [] },
      },
      tenantId: 'fictional-tenant',
      venueId: 'fictional-venue',
      includeSecondLayer: false,
      asOf: new Date(date),
    })
    expect(directory.knowledge).toHaveLength(0)
    expect(preview.counts).toEqual({ places: 0, knowledge: 0 })
    expect(preview.default.mode).toBe(
      buildGuestVenueGuidePrompt(directory, { currentDate: date }).mode,
    )
    expect(preview.default.mode).toBe('NONE')
    expect(preview.evidence.mode).toBe('NONE')
    expect(preview.assumptions.join(' ')).toContain('no live authority')
  })
  it('retains ordinary knowledge and places while excluding connected-source knowledge only', () => {
    const input = fixture()
    input.knowledgeEntries.create[0]!.provenance = {
      ...provenance,
      sourceType: 'SOURCE_CONNECTION',
    }
    input.places.create[0]!.provenance = { ...provenance, sourceType: 'SOURCE_CONNECTION' }
    const result = previewVenuePackageGuide(input, date)
    expect(result.counts).toEqual({ places: 1, knowledge: 23 })
    expect(result.default.mode).toBe('FULL')
  })
})
