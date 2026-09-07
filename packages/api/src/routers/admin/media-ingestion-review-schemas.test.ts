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
  it.each([
    'GOOGLE_COMPLETE_VIDEO',
    'GOOGLE_STATIC_VIDEO_1FPS',
    'SAMPLED_VIDEO',
    'SAMPLED_VIDEO_FALLBACK',
  ] as const)('accepts the finite %s route for a video finding', (videoAnalysisMethod) => {
    expect(mediaFindingSchema.parse({ ...baseFinding, videoAnalysisMethod })).toMatchObject({
      videoAnalysisMethod,
    })
  })

  it('preserves legacy video findings that predate route tracking', () => {
    expect(mediaFindingSchema.parse(baseFinding)).not.toHaveProperty('videoAnalysisMethod')
  })

  const coverage = {
    inputScope: 'uploaded-video',
    visualCoverage: 'provider-static-1fps',
    audioCoverage: 'provider-video-audio',
    exhaustiveFrames: false,
  }
  const observation = {
    kind: 'visible_text',
    statement: 'North Hall',
    evidenceChannel: 'visible_text',
    directness: 'observed',
    confidence: 'probable',
    startSeconds: 12,
    endSeconds: 13,
    region: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
  }

  it('round trips current worker coverage and timed observations through review', () => {
    const finding = {
      ...baseFinding,
      videoAnalysisMethod: 'GOOGLE_STATIC_VIDEO_1FPS',
      videoAnalysisCoverage: coverage,
      observations: [observation],
    }
    expect(mediaFindingSchema.parse(finding)).toEqual(finding)
  })

  it.each([
    { videoAnalysisMethod: 'SAMPLED_VIDEO', videoAnalysisCoverage: coverage },
    { videoAnalysisMethod: 'GOOGLE_COMPLETE_VIDEO', videoAnalysisCoverage: coverage },
    {
      videoAnalysisMethod: 'GOOGLE_STATIC_VIDEO_1FPS',
      videoAnalysisCoverage: { ...coverage, exhaustiveFrames: true },
    },
    { observations: [{ ...observation, endSeconds: 11 }] },
    { observations: [{ ...observation, region: { ...observation.region, width: 1 } }] },
    { observations: [{ ...observation, region: { ...observation.region, width: 0 } }] },
  ])('rejects inconsistent or malformed evidence %#', (extra) => {
    expect(mediaFindingSchema.safeParse({ ...baseFinding, ...extra }).success).toBe(false)
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
