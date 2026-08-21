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
  crmCore: {
    environmentVariable: 'CRM_CORE_ENABLED',
    defaultEnabled: false,
  },
  crmProspectOutreach: {
    environmentVariable: 'CRM_PROSPECT_OUTREACH_ENABLED',
    defaultEnabled: false,
  },
  crmAutonomousOutreach: {
    environmentVariable: 'CRM_AUTONOMOUS_OUTREACH_ENABLED',
    defaultEnabled: false,
  },
  crmCalendar: {
    environmentVariable: 'CRM_CALENDAR_ENABLED',
    defaultEnabled: false,
  },
  crmMeet: {
    environmentVariable: 'CRM_MEET_ENABLED',
    defaultEnabled: false,
  },
  crmDrive: {
    environmentVariable: 'CRM_DRIVE_ENABLED',
    defaultEnabled: false,
  },
  crmBotMode: {
    environmentVariable: 'CRM_BOT_MODE_ENABLED',
    defaultEnabled: false,
  },
  billingUi: {
    environmentVariable: 'STRIPE_BILLING_UI_ENABLED',
    defaultEnabled: false,
  },
  billingCheckout: {
    environmentVariable: 'STRIPE_CHECKOUT_ENABLED',
    defaultEnabled: false,
  },
  billingPortal: {
    environmentVariable: 'STRIPE_CUSTOMER_PORTAL_ENABLED',
    defaultEnabled: false,
  },
  billingCancellation: {
    environmentVariable: 'STRIPE_CANCELLATION_ENABLED',
    defaultEnabled: false,
  },
  billingWebhook: {
    environmentVariable: 'STRIPE_WEBHOOK_PROCESSING_ENABLED',
    defaultEnabled: false,
  },
  billingReconciliation: {
    environmentVariable: 'STRIPE_RECONCILIATION_ENABLED',
    defaultEnabled: false,
  },
  billingEntitlementEnforcement: {
    environmentVariable: 'BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED',
    defaultEnabled: false,
  },
  stripeLiveMode: {
    environmentVariable: 'STRIPE_LIVE_MODE_ALLOWED',
    defaultEnabled: false,
  },
} as const

export type CrmFeatureClassification = 'public' | 'pilot' | 'internal' | 'off'
export type CrmFeatureKey =
  | 'core'
  | 'prospectOutreach'
  | 'autonomousOutreach'
  | 'calendar'
  | 'meet'
  | 'drive'
  | 'botMode'

export const CRM_FEATURE_POLICY = {
  core: { classification: 'internal', flag: 'crmCore' },
  prospectOutreach: { classification: 'pilot', flag: 'crmProspectOutreach' },
  autonomousOutreach: { classification: 'off', flag: 'crmAutonomousOutreach' },
  calendar: { classification: 'off', flag: 'crmCalendar' },
  meet: { classification: 'off', flag: 'crmMeet' },
  drive: { classification: 'off', flag: 'crmDrive' },
  botMode: { classification: 'off', flag: 'crmBotMode' },
} as const satisfies Record<
  CrmFeatureKey,
  { classification: CrmFeatureClassification; flag: FeatureFlagKey }
>

/** Server-owned visibility decision. `off` remains unavailable even if an env flag is set. */
export function isCrmFeatureAvailable(
  key: CrmFeatureKey,
  actor: 'platform-admin' | 'tenant-user' | 'public',
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const policy = CRM_FEATURE_POLICY[key]
  if (policy.classification === 'off') return false
  if (policy.classification === 'internal' || policy.classification === 'pilot') {
    if (actor !== 'platform-admin') return false
  }
  return isFeatureEnabled(policy.flag, environment)
}

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS

export const BILLING_TENANT_FLAG_KEYS = {
  ui: 'billing-ui-v1',
  checkout: 'billing-checkout-v1',
  portal: 'billing-portal-v1',
  cancellation: 'billing-cancellation-v1',
  entitlementEnforcement: 'billing-entitlement-enforcement-v1',
} as const

export type BillingTenantFlagKey =
  (typeof BILLING_TENANT_FLAG_KEYS)[keyof typeof BILLING_TENANT_FLAG_KEYS]

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
