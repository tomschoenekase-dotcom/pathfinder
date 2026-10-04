import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ stored: null as unknown }))

vi.mock('../routers/venue-package', () => ({
  parseStoredVenuePackagePreview: () => mocks.stored,
  assertStoredVenuePackageEvidenceCurrent: () => undefined,
  buildVenuePackagePreview: async () => ({}),
  VenuePackageApprovedBaseStaleError: class extends Error {},
}))

import { loadReviewableVenuePackageEvaluationPreview } from './reviewable-package-evaluation'

const place = (id: string, name: string, visibility: string) => ({
  id,
  name,
  type: 'exhibit',
  shortDescription: null,
  longDescription: null,
  areaName: null,
  hours: null,
  photoUrl: null,
  lat: null,
  lng: null,
  tags: [],
  isActive: true,
  visibility,
})
const entry = (id: string, title: string, visibility: string) => ({
  id,
  title,
  category: 'General',
  content: `${title} content`,
  isEnabled: true,
  visibility,
})
const changedPlace = (name: string) => ({
  name,
  type: 'exhibit',
  tags: [],
  isActive: true,
})

const db = {
  venuePackage: {
    findFirst: async () => ({
      id: 'pkg_1',
      venueId: 'venue_a',
      schemaVersion: 3,
      payload: {
        schemaVersion: 1,
        places: [{ name: 'Lion House', type: 'exhibit', tags: [], importanceScore: 0 }],
        knowledgeEntries: [],
      },
      payloadHash: 'a'.repeat(64),
      baseDigest: 'b'.repeat(64),
      validationReport: {},
      previewPlan: {},
      status: 'DRAFT',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      approvedAt: null,
    }),
  },
  venue: {
    findFirst: async () => ({
      id: 'venue_a',
      name: 'Venue A',
      description: null,
      category: null,
      chatTheme: null,
      chatAccentColor: null,
      chatFont: null,
      chatLogoUrl: null,
      chatBannerUrl: null,
      aiGuideName: null,
      aiTone: null,
      tonePreset: null,
      tonePresetVersion: null,
      places: [
        place('p_public', 'Lion House', 'PUBLIC'),
        place('p_hidden', 'Back office', 'SECOND_LAYER'),
      ],
      knowledgeEntries: [
        entry('k_public', 'Tickets', 'PUBLIC'),
        entry('k_hidden', 'Door code', 'SECOND_LAYER'),
      ],
    }),
  },
} as never

function setStored() {
  mocks.stored = {
    schemaVersion: 3,
    report: { errors: [], semanticDuplicateScan: { status: 'COMPLETE' } },
    changes: {
      venue: { expectedVersionId: null, change: [], unchanged: 0 },
      places: {
        add: [],
        // A package change that names an employee-only row must not resurrect it in a guest preview.
        change: [
          { id: 'p_hidden', after: changedPlace('Back office (renamed)') },
          { id: 'p_public', after: changedPlace('Lion House (renamed)') },
        ],
        remove: [],
        unchanged: 0,
      },
      knowledgeEntries: {
        add: [{ value: { title: 'New fact', category: 'General', content: 'New fact content' } }],
        change: [
          {
            id: 'k_hidden',
            after: {
              title: 'Door code',
              category: 'General',
              content: 'Now 9999',
              isEnabled: true,
            },
          },
        ],
        remove: [],
        unchanged: 0,
      },
    },
  }
}

describe('reviewable package preview audiences', () => {
  it('guest previews carry only public rows and drop package changes that name hidden ones', async () => {
    setStored()
    const result = await loadReviewableVenuePackageEvaluationPreview(
      db,
      'tenant_a',
      { venueId: 'venue_a', packageId: 'pkg_1' },
      { publicAudienceOnly: true },
    )
    const names = result.preview.experience.places.map((item) => item.name)
    expect(names).toEqual(['Lion House (renamed)'])
    const titles = result.preview.experience.knowledgeEntries.map((item) => item.title)
    expect(titles).toEqual(['New fact', 'Tickets'])
    const serialized = JSON.stringify(result.preview)
    for (const secret of ['Back office', 'Door code', '9999'])
      expect(serialized).not.toContain(secret)
    expect(result.package.status).toBe('DRAFT')
  })

  it('the unfiltered evaluation preview is unchanged for internal callers', async () => {
    setStored()
    const result = await loadReviewableVenuePackageEvaluationPreview(db, 'tenant_a', {
      venueId: 'venue_a',
      packageId: 'pkg_1',
    })
    expect(result.preview.experience.places.map((item) => item.name)).toEqual([
      'Back office (renamed)',
      'Lion House (renamed)',
    ])
  })
})
