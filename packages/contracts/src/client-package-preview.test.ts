import { describe, expect, it } from 'vitest'
import { ClientVenuePackagePreview } from './client-package-preview'

describe('client package preview contract', () => {
  it('accepts only an effective visitor experience without package mechanics', () => {
    const value = {
      venue: {
        id: 'venue_1',
        name: 'Museum',
        description: null,
        category: null,
        branding: { theme: null, accentColor: null, font: null, logoUrl: null, bannerUrl: null },
        guide: { name: null, tone: { preset: 'friendly', behaviorVersion: 1 } },
      },
      package: { id: 'package_1', status: 'APPROVED', approvedAt: '2030-01-01T00:00:00.000Z' },
      experience: {
        places: [],
        knowledgeEntries: [],
        summary: { placeCount: 0, knowledgeEntryCount: 0 },
      },
      staleness: 'CURRENT',
      autoApply: false,
      published: false,
      guestAccessible: false,
    }
    expect(ClientVenuePackagePreview.safeParse(value).success).toBe(true)
    expect(ClientVenuePackagePreview.safeParse({ ...value, schemaVersion: 3 }).success).toBe(false)
  })
})
