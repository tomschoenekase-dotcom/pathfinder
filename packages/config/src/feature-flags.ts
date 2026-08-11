export const FEATURE_FLAGS = {
  embedPreview: {
    environmentVariable: 'EMBED_PREVIEW_ENABLED',
    defaultEnabled: false,
  },
  richerGuestComponents: {
    environmentVariable: 'RICHER_GUEST_COMPONENTS_ENABLED',
    defaultEnabled: false,
  },
  generalizedContentCapabilities: {
    environmentVariable: 'GENERALIZED_CONTENT_CAPABILITIES_ENABLED',
    defaultEnabled: false,
  },
  onboardingAutomation: {
    environmentVariable: 'ONBOARDING_AUTOMATION_ENABLED',
    defaultEnabled: false,
  },
  autonomousSupportActions: {
    environmentVariable: 'AUTONOMOUS_SUPPORT_ACTIONS_ENABLED',
    defaultEnabled: false,
  },
  mcpWriteTools: {
    environmentVariable: 'MCP_WRITE_TOOLS_ENABLED',
    defaultEnabled: false,
  },
  partnerReadApi: {
    environmentVariable: 'PARTNER_READ_API_ENABLED',
    defaultEnabled: false,
  },
  thinSdkRelease: {
    environmentVariable: 'THIN_SDK_RELEASE_ENABLED',
    defaultEnabled: false,
  },
} as const

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS

export function isFeatureEnabled(
  key: FeatureFlagKey,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const flag = FEATURE_FLAGS[key]
  const configured = environment[flag.environmentVariable]
  if (configured === undefined) return flag.defaultEnabled
  return configured === 'true'
}

export function isEmbedPreviewEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isFeatureEnabled('embedPreview', environment)
}
