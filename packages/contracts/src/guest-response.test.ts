import { describe, expect, it } from 'vitest'

import {
  GuestPublicErrorCode,
  GuestResponseBlock,
  GuestStructuredResponse,
  legacyGuestResponseToBlocks,
} from './guest-response'

describe('GuestPublicErrorCode', () => {
  it('exposes the complete stable public failure taxonomy', () => {
    expect(GuestPublicErrorCode.options).toEqual([
      'PROVIDER_UNAVAILABLE',
      'RATE_LIMITED',
      'OUTCOME_AMBIGUOUS',
      'CONTENT_UNAVAILABLE',
      'REJECTED',
      'TRANSIENT_FAILURE',
    ])
  })
})

describe('GuestStructuredResponse', () => {
  it('accepts a versioned mix of browser-safe response blocks', () => {
    const result = GuestStructuredResponse.safeParse({
      version: 1,
      blocks: [
        { type: 'text', text: 'The west entrance is open.' },
        {
          type: 'actions',
          actions: [{ label: 'Visitor information', href: 'https://museum.example/visit' }],
        },
        {
          type: 'citations',
          citations: [{ label: 'Venue website', detail: 'Updated today' }],
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  it.each(['javascript:alert(1)', 'data:text/html,bad', 'file:///secrets'])(
    'rejects the unsafe action URL %s',
    (href) => {
      expect(
        GuestResponseBlock.safeParse({
          type: 'actions',
          actions: [{ label: 'Unsafe', href }],
        }).success,
      ).toBe(false)
    },
  )

  it('accepts typed actions only when their validated target matches the action type', () => {
    expect(
      GuestResponseBlock.safeParse({
        type: 'actions',
        actions: [
          {
            type: 'START_DIRECTIONS',
            label: 'Directions to the west entrance',
            target: { kind: 'LOCATION_ID', locationId: 'west-entrance' },
            analyticsKey: 'directions.west-entrance',
          },
          {
            type: 'CALL',
            label: 'Call the front desk',
            target: { kind: 'PHONE', phone: '+13125550100' },
            analyticsKey: 'call.front-desk',
            confirmationRequired: true,
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      GuestResponseBlock.safeParse({
        type: 'actions',
        actions: [
          {
            type: 'CALL',
            label: 'Unsafe mismatch',
            target: { kind: 'URL', url: 'https://example.com' },
            analyticsKey: 'call.bad',
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('rejects unknown blocks so clients do not guess at future payloads', () => {
    expect(GuestResponseBlock.safeParse({ type: 'html', html: '<b>unsafe</b>' }).success).toBe(
      false,
    )
  })

  it('accepts the bounded choices, media, event, and location subset', () => {
    expect(
      GuestStructuredResponse.safeParse({
        version: 1,
        blocks: [
          {
            type: 'choices',
            label: 'What next?',
            choices: [{ id: 'hours', label: 'Hours', value: 'What are today’s hours?' }],
          },
          {
            type: 'gallery',
            label: 'Highlights',
            images: [{ src: 'https://cdn.example/gallery.jpg', alt: 'Sunlit east gallery' }],
          },
          {
            type: 'events',
            label: 'Today',
            events: [
              {
                id: 'tour',
                title: 'Gallery tour',
                startsAt: '2030-01-01T10:00:00-06:00',
                endsAt: '2030-01-01T11:00:00-06:00',
              },
            ],
          },
          {
            type: 'location',
            name: 'East entrance',
            latitude: 41.9,
            longitude: -87.6,
            mapHref: 'https://maps.example/east-entrance',
          },
        ],
      }).success,
    ).toBe(true)
  })

  it.each([
    'http://cdn.example/image.jpg',
    'javascript:alert(1)',
    'https://user:password@cdn.example/image.jpg',
    'https://cdn.example/image.jpg?access_token=secret',
    'https://cdn.example/image.jpg#signature=secret',
  ])('rejects unsafe or secret-bearing rich media URL %s', (src) => {
    expect(
      GuestResponseBlock.safeParse({
        type: 'image',
        image: { src, alt: 'Gallery' },
      }).success,
    ).toBe(false)
  })

  it('rejects oversized arrays and incomplete coordinate pairs', () => {
    expect(
      GuestResponseBlock.safeParse({
        type: 'choices',
        label: 'Choose',
        choices: Array.from({ length: 9 }, (_, index) => ({
          id: String(index),
          label: `Choice ${index}`,
          value: `choice-${index}`,
        })),
      }).success,
    ).toBe(false)
    expect(
      GuestResponseBlock.safeParse({
        type: 'location',
        name: 'Partial location',
        latitude: 41.9,
        mapHref: 'https://maps.example/location',
      }).success,
    ).toBe(false)
  })

  it('rejects undeclared secret-bearing metadata instead of silently stripping it', () => {
    expect(
      GuestResponseBlock.safeParse({
        type: 'gallery',
        label: 'Private payload',
        images: [
          {
            src: 'https://cdn.example/image.jpg',
            alt: 'Gallery',
            apiKey: 'must-not-cross-the-browser-contract',
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('converts legacy text and place cards without duplicating or dropping them', () => {
    const place = {
      id: 'gallery',
      name: 'Gallery',
      type: 'EXHIBIT',
      photoUrl: null,
      shortDescription: null,
      areaName: null,
      hours: null,
      lat: null,
      lng: null,
    }
    expect(legacyGuestResponseToBlocks({ content: 'Head upstairs.', places: [place] })).toEqual([
      { type: 'text', text: 'Head upstairs.' },
      { type: 'places', places: [place] },
    ])
  })
})
