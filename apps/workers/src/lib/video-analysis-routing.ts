export const FULL_VIDEO_FALLBACK_UNCERTAINTY =
  'Google static video processing was unavailable; Torchiko used bounded interval frame sampling and optional narration transcription instead.'

export type VideoAnalysisMethod =
  | 'GOOGLE_STATIC_VIDEO_1FPS'
  | 'SAMPLED_VIDEO'
  | 'SAMPLED_VIDEO_FALLBACK'

export type VideoAnalysisCoverage = {
  inputScope: 'uploaded-video' | 'sampled-frames'
  visualCoverage: 'provider-static-1fps' | 'bounded-interval-samples'
  audioCoverage: 'provider-video-audio' | 'optional-transcription'
  exhaustiveFrames: false
}

const sampledCoverage: VideoAnalysisCoverage = {
  inputScope: 'sampled-frames',
  visualCoverage: 'bounded-interval-samples',
  audioCoverage: 'optional-transcription',
  exhaustiveFrames: false,
}

export async function runOptionalGoogleVideoAnalysis<
  T extends { uncertainties: string[] },
>(params: {
  enabled: boolean
  analyzeGoogleVideo: () => Promise<T>
  analyzeFallback: () => Promise<T>
  shouldPropagate: (error: unknown) => boolean
}): Promise<{ analysis: T; method: VideoAnalysisMethod; coverage: VideoAnalysisCoverage }> {
  if (!params.enabled) {
    return {
      analysis: await params.analyzeFallback(),
      method: 'SAMPLED_VIDEO',
      coverage: sampledCoverage,
    }
  }

  try {
    return {
      analysis: await params.analyzeGoogleVideo(),
      method: 'GOOGLE_STATIC_VIDEO_1FPS',
      coverage: {
        inputScope: 'uploaded-video',
        visualCoverage: 'provider-static-1fps',
        audioCoverage: 'provider-video-audio',
        exhaustiveFrames: false,
      },
    }
  } catch (error) {
    if (params.shouldPropagate(error)) throw error
    const fallback = await params.analyzeFallback()
    return {
      analysis: {
        ...fallback,
        uncertainties: [FULL_VIDEO_FALLBACK_UNCERTAINTY, ...fallback.uncertainties],
      },
      method: 'SAMPLED_VIDEO_FALLBACK',
      coverage: sampledCoverage,
    }
  }
}
