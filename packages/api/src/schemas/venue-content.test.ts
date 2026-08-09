import { describe, expect, it } from 'vitest'

import { canonicalVenueContentImportPayload, ImportVenueContentInput } from './venue-content'

const venueId = 'cvenueabc123456789012'

describe('canonical venue content import payload', () => {
  it('preserves legacy unknown-key stripping for knowledge imports', () => {
    const parsed = ImportVenueContentInput.parse({
      venueId,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      places: [],
      knowledgeEntries: [
        { title: 'Policy', category: 'FAQ', content: 'Details', legacyExtra: 'ignored' },
      ],
    })

    expect(parsed.knowledgeEntries).toEqual([
      { title: 'Policy', category: 'FAQ', content: 'Details', isEnabled: true },
    ])
  })

  it('normalizes schema defaults and excludes the attempt key', () => {
    const omittedDefaults = ImportVenueContentInput.parse({
      venueId,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      places: [{ name: 'Lobby', type: 'room' }],
      knowledgeEntries: [{ title: 'Policy', category: 'FAQ', content: 'Details' }],
    })
    const explicitDefaults = ImportVenueContentInput.parse({
      knowledgeEntries: [{ content: 'Details', category: 'FAQ', title: 'Policy', isEnabled: true }],
      places: [{ importanceScore: 0, tags: [], type: 'room', name: 'Lobby' }],
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      venueId,
    })

    expect(canonicalVenueContentImportPayload(omittedDefaults)).toBe(
      canonicalVenueContentImportPayload(explicitDefaults),
    )
  })

  it('preserves meaningful content and array ordering', () => {
    const base = ImportVenueContentInput.parse({
      venueId,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      places: [
        { name: 'Lobby', type: 'room', tags: ['indoor', 'accessible'] },
        { name: 'Atrium', type: 'room' },
      ],
      knowledgeEntries: [],
    })
    const renamed = ImportVenueContentInput.parse({
      ...base,
      places: [{ ...base.places[0]!, name: 'Changed' }, base.places[1]!],
    })
    const reordered = ImportVenueContentInput.parse({
      ...base,
      places: [...base.places].reverse(),
    })
    const reorderedTags = ImportVenueContentInput.parse({
      ...base,
      places: [{ ...base.places[0]!, tags: [...base.places[0]!.tags].reverse() }, base.places[1]!],
    })

    const canonical = canonicalVenueContentImportPayload(base)
    expect(canonicalVenueContentImportPayload(renamed)).not.toBe(canonical)
    expect(canonicalVenueContentImportPayload(reordered)).not.toBe(canonical)
    expect(canonicalVenueContentImportPayload(reorderedTags)).not.toBe(canonical)
  })
})
