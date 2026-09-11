import { describe, expect, it } from 'vitest'

import { MediaSourceObservationSchema } from './media-evidence'

describe('MediaSourceObservationSchema', () => {
  const base = {
    kind: 'visible_text',
    statement: 'North Hall',
    evidenceChannel: 'visible_text',
    directness: 'observed',
    confidence: 'confirmed',
    processingMethod: 'provider_image_analysis',
  } as const

  it.each([
    { type: 'whole_source' },
    { type: 'image_region', region: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 } },
    { type: 'document_page', page: 2 },
    { type: 'video_interval', startSeconds: 4, endSeconds: 6 },
  ] as const)('accepts truthful source locator %#', (locator) => {
    expect(MediaSourceObservationSchema.parse({ ...base, locator }).locator).toEqual(locator)
  })

  it.each([
    { type: 'document_page', page: 0 },
    { type: 'video_interval', startSeconds: 8, endSeconds: 2 },
    { type: 'image_region', region: { x: 0.8, y: 0, width: 0.3, height: 1 } },
  ])('rejects invented or invalid precision %#', (locator) => {
    expect(MediaSourceObservationSchema.safeParse({ ...base, locator }).success).toBe(false)
  })
})
