export const FULL_VIDEO_FALLBACK_UNCERTAINTY =
  'Google full-video understanding was unavailable; Torchiko used bounded frame sampling and optional narration transcription instead.'

export async function runOptionalFullVideoAnalysis<T extends { uncertainties: string[] }>(params: {
  enabled: boolean
  analyzeFullVideo: () => Promise<T>
  analyzeFallback: () => Promise<T>
  shouldPropagate: (error: unknown) => boolean
}): Promise<T> {
  if (!params.enabled) return params.analyzeFallback()

  try {
    return await params.analyzeFullVideo()
  } catch (error) {
    if (params.shouldPropagate(error)) throw error
    const fallback = await params.analyzeFallback()
    return {
      ...fallback,
      uncertainties: [FULL_VIDEO_FALLBACK_UNCERTAINTY, ...fallback.uncertainties],
    }
  }
}
