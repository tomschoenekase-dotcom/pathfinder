import { describe, expect, it } from 'vitest'

import { mediaFindingSchema } from './media-ingestion-review-schemas'

const baseFinding = {
  sourceId: 'S-1',
  filename: 'source.mp4',
  mediaType: 'VIDEO' as const,
  summary: 'A complete venue walkthrough.',
  uncertainties: [],
}

describe('media ingestion review finding provenance', () => {
  it.each(['GOOGLE_COMPLETE_VIDEO', 'SAMPLED_VIDEO', 'SAMPLED_VIDEO_FALLBACK'] as const)(
    'accepts the finite %s route for a video finding',
    (videoAnalysisMethod) => {
      expect(mediaFindingSchema.parse({ ...baseFinding, videoAnalysisMethod })).toMatchObject({
        videoAnalysisMethod,
      })
    },
  )

  it('preserves legacy video findings that predate route tracking', () => {
    expect(mediaFindingSchema.parse(baseFinding)).not.toHaveProperty('videoAnalysisMethod')
  })

  it.each(['IMAGE', 'AUDIO', 'DOCUMENT'] as const)(
    'rejects video provenance on a %s finding',
    (mediaType) => {
      expect(() =>
        mediaFindingSchema.parse({
          ...baseFinding,
          filename: 'source.bin',
          mediaType,
          videoAnalysisMethod: 'GOOGLE_COMPLETE_VIDEO',
        }),
      ).toThrow('Video analysis provenance is only valid for video findings.')
    },
  )
})
