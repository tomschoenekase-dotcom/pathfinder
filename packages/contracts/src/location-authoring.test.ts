import { describe, expect, it } from 'vitest'

import {
  LocationDraftProposalSnapshotSchema,
  VenueLocationDraftFieldsSchema,
} from './location-authoring'

const legacyDraft = {
  stableKey: 'east-entrance',
  kind: 'ENTRANCE',
  displayName: 'East entrance',
  description: null,
  visibility: 'PUBLIC',
  floorId: null,
  parentLocationId: null,
  coordinates: null,
  mapAnchor: null,
  externalMapReference: null,
  accessibilityMetadata: {},
}

describe('location authoring primary Place compatibility', () => {
  it('parses prior proposal snapshots without inventing a mapping', () => {
    const parsed = LocationDraftProposalSnapshotSchema.parse({
      contractVersion: 1,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      draft: legacyDraft,
      canonicalVenueContentChanged: false,
    })
    expect(parsed.draft.primaryPlaceId).toBeUndefined()
  })

  it('distinguishes an omitted mapping from an explicit clear', () => {
    expect(VenueLocationDraftFieldsSchema.parse(legacyDraft).primaryPlaceId).toBeUndefined()
    expect(
      VenueLocationDraftFieldsSchema.parse({ ...legacyDraft, primaryPlaceId: null }).primaryPlaceId,
    ).toBeNull()
    expect(
      VenueLocationDraftFieldsSchema.parse({ ...legacyDraft, primaryPlaceId: 'place-1' })
        .primaryPlaceId,
    ).toBe('place-1')
  })
})
