import { describe, expect, it, vi } from 'vitest'

import {
  FULL_VIDEO_FALLBACK_UNCERTAINTY,
  runOptionalFullVideoAnalysis,
} from './video-analysis-routing'

const full = { summary: 'whole video', uncertainties: [] as string[] }
const sampled = { summary: 'sampled frames', uncertainties: ['Frames were sampled.'] }

describe('optional full-video analysis routing', () => {
  it('does not contact the full-video provider unless explicitly enabled', async () => {
    const analyzeFullVideo = vi.fn(async () => full)

    await expect(
      runOptionalFullVideoAnalysis({
        enabled: false,
        analyzeFullVideo,
        analyzeFallback: vi.fn(async () => sampled),
        shouldPropagate: () => false,
      }),
    ).resolves.toEqual({ analysis: sampled, method: 'SAMPLED_VIDEO' })
    expect(analyzeFullVideo).not.toHaveBeenCalled()
  })

  it('uses full-video results when the opted-in provider succeeds', async () => {
    const analyzeFallback = vi.fn(async () => sampled)

    await expect(
      runOptionalFullVideoAnalysis({
        enabled: true,
        analyzeFullVideo: vi.fn(async () => full),
        analyzeFallback,
        shouldPropagate: () => false,
      }),
    ).resolves.toEqual({ analysis: full, method: 'GOOGLE_COMPLETE_VIDEO' })
    expect(analyzeFallback).not.toHaveBeenCalled()
  })

  it('falls back with explicit provenance after an ordinary provider failure', async () => {
    await expect(
      runOptionalFullVideoAnalysis({
        enabled: true,
        analyzeFullVideo: vi.fn(async () => {
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
    })
  })

  it('does not bypass admission, budget, cancellation, or unrecoverable failures', async () => {
    const gate = new Error('admission denied')
    const analyzeFallback = vi.fn(async () => sampled)

    await expect(
      runOptionalFullVideoAnalysis({
        enabled: true,
        analyzeFullVideo: vi.fn(async () => {
          throw gate
        }),
        analyzeFallback,
        shouldPropagate: (error) => error === gate,
      }),
    ).rejects.toBe(gate)
    expect(analyzeFallback).not.toHaveBeenCalled()
  })
})
