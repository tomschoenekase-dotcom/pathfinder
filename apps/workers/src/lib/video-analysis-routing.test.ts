import { describe, expect, it, vi } from 'vitest'

import {
  FULL_VIDEO_FALLBACK_UNCERTAINTY,
  runOptionalGoogleVideoAnalysis,
} from './video-analysis-routing'

const full = { summary: 'whole video', uncertainties: [] as string[] }
const sampled = { summary: 'sampled frames', uncertainties: ['Frames were sampled.'] }

describe('optional full-video analysis routing', () => {
  it('does not contact the full-video provider unless explicitly enabled', async () => {
    const analyzeGoogleVideo = vi.fn(async () => full)

    await expect(
      runOptionalGoogleVideoAnalysis({
        enabled: false,
        analyzeGoogleVideo,
        analyzeFallback: vi.fn(async () => sampled),
        shouldPropagate: () => false,
      }),
    ).resolves.toEqual({
      analysis: sampled,
      method: 'SAMPLED_VIDEO',
      coverage: {
        inputScope: 'sampled-frames',
        visualCoverage: 'bounded-interval-samples',
        audioCoverage: 'optional-transcription',
        exhaustiveFrames: false,
      },
    })
    expect(analyzeGoogleVideo).not.toHaveBeenCalled()
  })

  it('labels the Files API generateContent route as static 1 FPS rather than exhaustive', async () => {
    const analyzeFallback = vi.fn(async () => sampled)

    await expect(
      runOptionalGoogleVideoAnalysis({
        enabled: true,
        analyzeGoogleVideo: vi.fn(async () => full),
        analyzeFallback,
        shouldPropagate: () => false,
      }),
    ).resolves.toEqual({
      analysis: full,
      method: 'GOOGLE_STATIC_VIDEO_1FPS',
      coverage: {
        inputScope: 'uploaded-video',
        visualCoverage: 'provider-static-1fps',
        audioCoverage: 'provider-video-audio',
        exhaustiveFrames: false,
      },
    })
    expect(analyzeFallback).not.toHaveBeenCalled()
  })

  it('falls back with explicit provenance after an ordinary provider failure', async () => {
    await expect(
      runOptionalGoogleVideoAnalysis({
        enabled: true,
        analyzeGoogleVideo: vi.fn(async () => {
          throw new Error('provider unavailable')
        }),
        analyzeFallback: vi.fn(async () => sampled),
        shouldPropagate: () => false,
      }),
    ).resolves.toEqual({
      analysis: {
        summary: 'sampled frames',
        uncertainties: [FULL_VIDEO_FALLBACK_UNCERTAINTY, 'Frames were sampled.'],
      },
      method: 'SAMPLED_VIDEO_FALLBACK',
      coverage: {
        inputScope: 'sampled-frames',
        visualCoverage: 'bounded-interval-samples',
        audioCoverage: 'optional-transcription',
        exhaustiveFrames: false,
      },
    })
  })

  it('does not bypass admission, budget, cancellation, or unrecoverable failures', async () => {
    const gate = new Error('admission denied')
    const analyzeFallback = vi.fn(async () => sampled)

    await expect(
      runOptionalGoogleVideoAnalysis({
        enabled: true,
        analyzeGoogleVideo: vi.fn(async () => {
          throw gate
        }),
        analyzeFallback,
        shouldPropagate: (error) => error === gate,
      }),
    ).rejects.toBe(gate)
    expect(analyzeFallback).not.toHaveBeenCalled()
  })
})
