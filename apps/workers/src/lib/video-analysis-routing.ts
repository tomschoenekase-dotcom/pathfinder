export const FULL_VIDEO_FALLBACK_UNCERTAINTY =
  'Google full-video understanding was unavailable; Torchiko used bounded frame sampling and optional narration transcription instead.'

export type VideoAnalysisMethod =
  | 'GOOGLE_COMPLETE_VIDEO'
  | 'SAMPLED_VIDEO'
  | 'SAMPLED_VIDEO_FALLBACK'

export async function runOptionalFullVideoAnalysis<T extends { uncertainties: string[] }>(params: {
  enabled: boolean
  analyzeFullVideo: () => Promise<T>
  analyzeFallback: () => Promise<T>
  shouldPropagate: (error: unknown) => boolean
}): Promise<{ analysis: T; method: VideoAnalysisMethod }> {
  if (!params.enabled) {
    return { analysis: await params.analyzeFallback(), method: 'SAMPLED_VIDEO' }
  }

  try {
    return { analysis: await params.analyzeFullVideo(), method: 'GOOGLE_COMPLETE_VIDEO' }
  } catch (error) {
    if (params.shouldPropagate(error)) throw error
    const fallback = await params.analyzeFallback()
    return {
      analysis: {
        ...fallback,
        uncertainties: [FULL_VIDEO_FALLBACK_UNCERTAINTY, ...fallback.uncertainties],
      },
      method: 'SAMPLED_VIDEO_FALLBACK',
    }
  }
}
