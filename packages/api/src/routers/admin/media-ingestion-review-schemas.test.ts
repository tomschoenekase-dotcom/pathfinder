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

  it.each([
    [
      'IMAGE',
      'provider_image_analysis',
      { type: 'image_region', region: { x: 0, y: 0, width: 1, height: 1 } },
    ],
    ['AUDIO', 'audio_transcription', { type: 'whole_source' }],
    ['DOCUMENT', 'text_extraction', { type: 'document_page', page: 3 }],
  ] as const)(
    'round trips %s source-native observations',
    (mediaType, processingMethod, locator) => {
      const sourceObservation = {
        kind: 'visible_text' as const,
        statement: 'North Hall',
        evidenceChannel: mediaType === 'AUDIO' ? ('speech' as const) : ('visible_text' as const),
        directness: 'observed' as const,
        confidence: 'unverified' as const,
        processingMethod,
        locator,
      }
      expect(
        mediaFindingSchema.parse({
          ...baseFinding,
          mediaType,
          sourceObservations: [sourceObservation],
        }).sourceObservations,
      ).toEqual([sourceObservation])
    },
  )

  it('rejects source precision or processing methods that do not match the media type', () => {
    expect(
      mediaFindingSchema.safeParse({
        ...baseFinding,
        mediaType: 'IMAGE',
        sourceObservations: [
          {
            kind: 'visible_text',
            statement: 'North Hall',
            evidenceChannel: 'visible_text',
            directness: 'observed',
            confidence: 'confirmed',
            processingMethod: 'text_extraction',
            locator: { type: 'document_page', page: 1 },
          },
        ],
      }).success,
    ).toBe(false)
  })

  it.each([
    {
      mediaType: 'IMAGE',
      videoAnalysisMethod: undefined,
      processingMethod: 'provider_image_analysis',
      evidenceChannel: 'speech',
    },
    {
      mediaType: 'VIDEO',
      videoAnalysisMethod: 'SAMPLED_VIDEO',
      processingMethod: 'provider_video_static_1fps',
      evidenceChannel: 'visual',
    },
  ])('rejects mismatched source channel or recorded video route %#', (variant) => {
    expect(
      mediaFindingSchema.safeParse({
        ...baseFinding,
        ...variant,
        sourceObservations: [
          {
            kind: 'entity_candidate',
            statement: 'A sign is present.',
            evidenceChannel: variant.evidenceChannel,
            directness: 'observed',
            confidence: 'probable',
            processingMethod: variant.processingMethod,
            locator: { type: 'whole_source' },
          },
        ],
      }).success,
    ).toBe(false)
  })
})
