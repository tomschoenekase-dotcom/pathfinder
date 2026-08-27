import { describe, expect, it } from 'vitest'

import {
  ApprovedVenueMediaCandidate,
  RegisterVenueMediaAssetInput,
  ReviewVenueMediaAssetInput,
} from './venue-media'

const registration = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  assetId: 'b66e2eef-b7d2-4ad0-8ee1-a892c8198f99',
  intakeUploadId: 'upload-1',
  kind: 'IMAGE',
  semanticDescription: 'A wide view of the east gallery entrance.',
  depictedSubjects: ['east gallery', 'blue orientation sign'],
  altText: 'East gallery entrance beside a blue orientation sign',
  sourceName: 'Venue operations photo archive',
  linkedPlaceIds: ['place-1'],
  linkedKnowledgeEntryIds: ['knowledge-1'],
} as const

describe('venue media contracts', () => {
  it('requires semantic and accessible metadata while defaulting to secondary importance', () => {
    expect(RegisterVenueMediaAssetInput.parse(registration)).toMatchObject({
      importance: 'SECONDARY',
    })
  })

  it.each([
    'http://venue.example/image.jpg',
    'https://user:password@venue.example/image.jpg',
    'https://venue.example/image.jpg?X-Amz-Signature=secret',
  ])('rejects unsafe source provenance URL %s', (sourceUrl) => {
    expect(() => RegisterVenueMediaAssetInput.parse({ ...registration, sourceUrl })).toThrow()
  })

  it('does not allow an approval without an explicit rights basis and evidence source', () => {
    expect(() =>
      ReviewVenueMediaAssetInput.parse({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        assetId: registration.assetId,
        requestId: '544b8a1c-1f75-43f4-944d-32b2f61c82d7',
        expectedLatestSequence: 0,
        action: 'APPROVE_CONTENT_USE',
        rightsStatement: 'The venue owns this photograph.',
      }),
    ).toThrow()
  })

  it('keeps approved candidates URL-free and explicitly delivery-gated', () => {
    const candidate = ApprovedVenueMediaCandidate.parse({
      assetId: registration.assetId,
      kind: 'IMAGE',
      semanticDescription: registration.semanticDescription,
      depictedSubjects: [...registration.depictedSubjects],
      altText: registration.altText,
      caption: null,
      usageGuidance: null,
      importance: 'SECONDARY',
      linkedPlaceIds: ['place-1'],
      linkedKnowledgeEntryIds: ['knowledge-1'],
      delivery: 'CONTROLLED_DERIVATIVE_REQUIRED',
    })
    expect(candidate).not.toHaveProperty('url')
    expect(candidate).not.toHaveProperty('objectKey')
  })
})
