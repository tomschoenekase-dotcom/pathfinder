import { describe, expect, it } from 'vitest'

import { checkVenuePackageOffline } from './check-offline'

/** Every venue here is fictional. */
const NOW = new Date('2026-10-27T15:00:00Z')

const topic = (key: string, title: string, content: string, sourceUrl?: string) => ({
  itemKey: `5b0f9d1e-2c3a-4d4b-8e5f-6a7b8c9d0e${key}`,
  provenance: {
    sourceType: 'official_website',
    contentOrigin: 'AI_GENERATED',
    ...(sourceUrl ? { sourceUrl } : {}),
  },
  value: { title, category: 'Visiting', content },
})

const pkg = (...create: unknown[]) => ({
  schemaVersion: 3,
  places: {},
  knowledgeEntries: { create },
})

describe('checkVenuePackageOffline', () => {
  it('passes a clean package and says what it could not check', () => {
    const result = checkVenuePackageOffline(
      pkg(
        topic(
          '01',
          'Parking',
          'Parking is free in the north lot.',
          'https://quillbrook.example/visit',
        ),
      ),
      { now: NOW, officialDomain: 'quillbrook.example' },
    )
    expect(result.readyOffline).toBe(true)
    expect(result.records).toEqual({ places: 0, knowledge: 1 })
    expect(result.sources).toEqual({
      hosts: { 'quillbrook.example': 1 },
      withoutUrl: 0,
      offOfficialDomain: [],
    })
    expect(result.notChecked.join(' ')).toMatch(/visitor answers/u)
  })

  it('blocks on schema errors with a fix, writing-guide findings and exact duplicates', () => {
    const broken = checkVenuePackageOffline(
      { schemaVersion: 3, places: {}, knowledgeEntries: {}, notes: 'research' },
      { now: NOW },
    )
    expect(broken.readyOffline).toBe(false)
    expect(broken.errors[0]).toMatchObject({ code: 'UNKNOWN_FIELD' })

    const result = checkVenuePackageOffline(
      pkg(
        topic('02', 'Rides overview', 'The rides covered here are Comet Chaser and Lily Pad Leap.'),
        topic('03', 'Parking', 'Parking is free.'),
        topic('04', 'parking', 'Lot B is free.'),
      ),
      { now: NOW },
    )
    expect(result.readyOffline).toBe(false)
    expect(result.guideQuality.map((finding) => finding.code)).toContain(
      'GUIDE_QUALITY_RECORD_VOICE',
    )
    expect(result.duplicates.map((finding) => finding.path)).toEqual([
      'knowledgeEntries.create.2.value.title',
    ])
  })

  it('reports advice without blocking, and sources from another site', () => {
    const result = checkVenuePackageOffline(
      pkg(
        topic(
          '05',
          'Splash Pad',
          'Splash Pad is a water-play area, closed for the season.',
          'https://othertown-park.example/splash',
        ),
      ),
      { now: NOW, officialDomain: 'quillbrook.example' },
    )
    expect(result.readyOffline).toBe(true)
    expect(result.authoring.map((finding) => finding.code)).toEqual(['UNDATED_STATUS'])
    expect(result.sources.offOfficialDomain).toEqual([
      expect.objectContaining({
        code: 'SOURCE_OFF_OFFICIAL_DOMAIN',
        path: 'knowledgeEntries.create.0.provenance.sourceUrl',
      }),
    ])
  })
})
