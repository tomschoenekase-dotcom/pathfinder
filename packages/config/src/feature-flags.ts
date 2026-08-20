export const FEATURE_FLAGS = {
  embedPreview: {
    environmentVariable: 'EMBED_PREVIEW_ENABLED',
    defaultEnabled: false,
  },
  voiceMode: {
    environmentVariable: 'VOICE_MODE_ENABLED',
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
  clientTochi: {
    environmentVariable: 'CLIENT_TOCHI_ENABLED',
    defaultEnabled: false,
  },
  venueCharacterMode: {
    environmentVariable: 'VENUE_CHARACTER_MODE_ENABLED',
    defaultEnabled: false,
  },
  characterRegistry: {
    environmentVariable: 'CHARACTER_REGISTRY_ENABLED',
    defaultEnabled: false,
  },
  tochiVenueCharacter: {
    environmentVariable: 'TOCHI_VENUE_CHARACTER_ENABLED',
    defaultEnabled: false,
  },
} as const

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS

/**
 * The private, two-key rollout surface for the Tochi system. A capability is
 * effective only when its server kill switch and this tenant allowlist flag
 * are both enabled. Keep these keys centralized so public, client, and admin
 * surfaces cannot drift onto different rollout names.
 */
export const TOCHI_TENANT_FLAG_KEYS = {
  clientTochi: 'client-tochi-v1',
  venueCharacterMode: 'venue-character-mode-v1',
  characterRegistry: 'character-registry-v1',
  tochiVenueCharacter: 'tochi-venue-character-v1',
} as const

export const TOCHI_ROLLOUT_FLAGS = [
  {
    featureKey: 'clientTochi',
    tenantFlagKey: TOCHI_TENANT_FLAG_KEYS.clientTochi,
    label: 'Client Tochi',
    description: 'Private portal guidance and confirmed support handoffs.',
  },
  {
    featureKey: 'venueCharacterMode',
    tenantFlagKey: TOCHI_TENANT_FLAG_KEYS.venueCharacterMode,
    label: 'Venue Character mode',
    description: 'Allows a venue to opt into a character presentation.',
  },
  {
    featureKey: 'characterRegistry',
    tenantFlagKey: TOCHI_TENANT_FLAG_KEYS.characterRegistry,
    label: 'Approved character registry',
    description: 'Allows only code-reviewed, publishable character packs.',
  },
  {
    featureKey: 'tochiVenueCharacter',
    tenantFlagKey: TOCHI_TENANT_FLAG_KEYS.tochiVenueCharacter,
    label: 'Tochi for Venue Bot',
    description: 'Allows the approved Tochi pack in the public visitor chat.',
  },
] as const satisfies ReadonlyArray<{
  featureKey: FeatureFlagKey
  tenantFlagKey: string
  label: string
  description: string
}>

export type TochiTenantFlagKey = (typeof TOCHI_ROLLOUT_FLAGS)[number]['tenantFlagKey']

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
