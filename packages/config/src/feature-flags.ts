export const FEATURE_FLAGS = {
  embedPreview: {
    environmentVariable: 'EMBED_PREVIEW_ENABLED',
    defaultEnabled: false,
  },
} as const

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS

export function isEmbedPreviewEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment.EMBED_PREVIEW_ENABLED === 'true'
}
