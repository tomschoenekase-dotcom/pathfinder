import { describe, expect, it } from 'vitest'
import { largeGuestVenueFixture } from './evaluation/guest-large-venue-fixture'
import { renderGuestVenueIndex } from './guest-venue-index'
import { buildGuestVenueGuidePrompt, staleGuestGuideRecordIds } from './guest-venue-directory'

describe('large guest venue card and source stress', () => {
  it('carries every ride, late status and distinct physical/rider height facts', () => {
    const directory = largeGuestVenueFixture()
    const prompt = renderGuestVenueIndex(directory)
    for (const entry of directory.knowledge) expect(prompt).toContain(`- ${entry.title}:`)
    expect(prompt).toContain('76 in maximum')
    expect(prompt).toContain('85 ft physical ride height')
    expect(prompt).toContain('Permanently closed.')
  })

  it('does not turn a long rider-height restriction into an incomplete permission', () => {
    const directory = largeGuestVenueFixture(1)
    directory.knowledge[0]!.content = `A family coaster.\nHeight: 36 inches minimum ${'with conditions '.repeat(35)}; 76 inches maximum.`
    const prompt = renderGuestVenueIndex(directory)
    expect(prompt).not.toContain('Height: 36 inches minimum')
    expect(prompt).toContain('Height: [long fact; consult full record]')
  })

  it('preserves closed status from the full place description', () => {
    const prompt = renderGuestVenueIndex({
      knowledge: [],
      places: [
        {
          name: 'Lantern Loop',
          type: 'ride',
          areaName: null,
          shortDescription: 'A junior roller coaster.',
          longDescription: 'A junior roller coaster.\nOperating status: Permanently closed.',
        },
      ],
    })
    expect(prompt).toContain('Permanently closed.')
  })

  it('retains full source URLs and exact default FULL/DIRECTORY behavior', () => {
    const directory = largeGuestVenueFixture()
    const full = buildGuestVenueGuidePrompt(directory, { currentDate: '2026-10-12' })
    expect(full.mode).toBe('FULL')
    for (const entry of directory.knowledge)
      expect(full.prompt).toContain(`Source URL: ${entry.sourceUrl}`)
    const compact = buildGuestVenueGuidePrompt(directory, {
      currentDate: '2026-10-12',
      maxFullChars: 200,
    })
    expect(compact.mode).toBe('DIRECTORY')
    expect(compact.recordIds.size).toBe(0)
  })

  it('drops place summaries before dropping inventory names at the directory bound', () => {
    const directory = largeGuestVenueFixture(0)
    directory.places = Array.from({ length: 400 }, (_, i) => ({
      id: `fictional-bound-${i}`,
      name: `Lantern Place ${i}`,
      type: 'ride',
      itemType: null,
      areaName: null,
      shortDescription: `A family ride ${'with colorful lanterns '.repeat(10)}.`,
      longDescription: null,
      lat: 0,
      lng: 0,
      tags: [],
      hours: null,
      photoUrl: null,
      sourceType: 'website_research',
      sourceName: null,
      sourceUrl: null,
    }))
    const guide = buildGuestVenueGuidePrompt(directory, {
      currentDate: '2026-10-12',
      maxFullChars: 200,
    })
    expect(guide.mode).toBe('DIRECTORY')
    expect(guide.rendererTruncated).toBe(false)
    for (const place of directory.places) expect(guide.prompt).toContain(`- ${place.name} (`)
  })

  it('keeps conflicting same-name safety facts on separate area-qualified cards', () => {
    const prompt = renderGuestVenueIndex({
      knowledge: [],
      places: ['North', 'South'].map((area, i) => ({
        name: 'Lantern Loop',
        type: 'ride',
        areaName: area,
        shortDescription: 'A junior coaster.',
        longDescription: `Height: ${i ? 52 : 36} inches minimum`,
      })),
    })
    expect(prompt).toContain(
      '- Lantern Loop (North): A junior coaster. | Height: 36 inches minimum',
    )
    expect(prompt).toContain(
      '- Lantern Loop (South): A junior coaster. | Height: 52 inches minimum',
    )
  })

  it('marks a place source-only correction stale so current attribution remains available', () => {
    const directory = largeGuestVenueFixture(0)
    const place = {
      id: 'fictional-source-place',
      name: 'Lantern Loop',
      type: 'ride',
      itemType: null,
      areaName: null,
      shortDescription: 'A junior coaster.',
      longDescription: null,
      lat: 0,
      lng: 0,
      tags: [],
      hours: null,
      photoUrl: null,
      sourceType: 'website_research',
      sourceName: 'Fictional park',
      sourceUrl: 'https://lantern.example/old/',
    }
    directory.places.push(place)
    const guide = buildGuestVenueGuidePrompt(directory, { currentDate: '2026-10-12' })
    expect(
      staleGuestGuideRecordIds({
        guide,
        directory,
        knowledgeEntries: [],
        places: [{ ...place, sourceUrl: 'https://lantern.example/new/' }],
      }),
    ).toEqual(new Set(['place:fictional-source-place']))
  })

  it('excludes mismatched tiered computed facts while preserving FULL older-version behavior', () => {
    const directory = largeGuestVenueFixture(1)
    const guide = buildGuestVenueGuidePrompt(directory, { currentDate: '2026-10-12' })
    const knowledgeEntries = [
      { ...directory.knowledge[0]!, updatedAt: new Date('2026-10-11T00:00:00Z') },
    ]
    expect(staleGuestGuideRecordIds({ guide, directory, places: [], knowledgeEntries }).size).toBe(
      0,
    )
    expect(
      staleGuestGuideRecordIds({
        guide: { ...guide, mode: 'TIERED', recordIds: new Set() },
        directory,
        places: [],
        knowledgeEntries,
      }),
    ).toEqual(new Set(['knowledge:fictional-ride-0']))
  })
})
