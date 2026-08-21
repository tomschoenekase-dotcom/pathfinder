import { describe, expect, it } from 'vitest'

import {
  BILLING_TENANT_FLAG_KEYS,
  FEATURE_FLAGS,
  isEmbedPreviewEnabled,
  isFeatureEnabled,
} from './feature-flags'

describe('embed preview feature boundary', () => {
  it('is documented as default-off', () => {
    expect(FEATURE_FLAGS.embedPreview).toEqual({
      environmentVariable: 'EMBED_PREVIEW_ENABLED',
      defaultEnabled: false,
    })
  })

  it('enables only for the exact true value', () => {
    expect(isEmbedPreviewEnabled({})).toBe(false)
    expect(isEmbedPreviewEnabled({ EMBED_PREVIEW_ENABLED: 'false' })).toBe(false)
    expect(isEmbedPreviewEnabled({ EMBED_PREVIEW_ENABLED: 'TRUE' })).toBe(false)
    expect(isEmbedPreviewEnabled({ EMBED_PREVIEW_ENABLED: 'true' })).toBe(true)
  })
})

describe('Packet 2 dark-launch boundaries', () => {
  it('keeps every risky infrastructure flag default-off', () => {
    for (const flag of Object.values(FEATURE_FLAGS)) {
      expect(flag.defaultEnabled).toBe(false)
      expect(isFeatureEnabledByEnvironmentVariable(flag.environmentVariable, {})).toBe(false)
    }
  })

  it('does not enable similarly spelled or truthy values', () => {
    expect(isFeatureEnabled('partnerReadApi', { PARTNER_READ_API_ENABLED: 'TRUE' })).toBe(false)
    expect(isFeatureEnabled('partnerReadApi', { PARTNER_READ_API_ENABLED: '1' })).toBe(false)
    expect(isFeatureEnabled('partnerReadApi', { PARTNER_READ_API_ENABLED: 'true' })).toBe(true)
  })
})

describe('Tochi and Character Mode rollout boundaries', () => {
  it('keeps every new product surface behind an exact default-off kill switch', () => {
    expect(FEATURE_FLAGS.clientTochi).toEqual({
      environmentVariable: 'CLIENT_TOCHI_ENABLED',
      defaultEnabled: false,
    })
    expect(FEATURE_FLAGS.venueCharacterMode).toEqual({
      environmentVariable: 'VENUE_CHARACTER_MODE_ENABLED',
      defaultEnabled: false,
    })
    expect(FEATURE_FLAGS.characterRegistry).toEqual({
      environmentVariable: 'CHARACTER_REGISTRY_ENABLED',
      defaultEnabled: false,
    })
    expect(FEATURE_FLAGS.tochiVenueCharacter).toEqual({
      environmentVariable: 'TOCHI_VENUE_CHARACTER_ENABLED',
      defaultEnabled: false,
    })
  })

  it('does not enable a character surface for truthy or similarly named values', () => {
    expect(isFeatureEnabled('venueCharacterMode', { VENUE_CHARACTER_MODE_ENABLED: '1' })).toBe(
      false,
    )
    expect(isFeatureEnabled('venueCharacterMode', { VENUE_CHARACTER_MODE_ENABLED: 'TRUE' })).toBe(
      false,
    )
    expect(isFeatureEnabled('venueCharacterMode', { VENUE_CHARACTER_MODE_ENABLED: 'true' })).toBe(
      true,
    )
  })
})

describe('Stripe Billing rollout boundaries', () => {
  it('keeps every billing capability default-off and names tenant pilot flags centrally', () => {
    for (const key of [
      'billingUi',
      'billingCheckout',
      'billingPortal',
      'billingWebhook',
      'billingReconciliation',
      'billingEntitlementEnforcement',
      'stripeLiveMode',
    ] as const) {
      expect(FEATURE_FLAGS[key].defaultEnabled).toBe(false)
      expect(isFeatureEnabled(key, {})).toBe(false)
    }
    expect(BILLING_TENANT_FLAG_KEYS).toEqual({
      ui: 'billing-ui-v1',
      checkout: 'billing-checkout-v1',
      portal: 'billing-portal-v1',
      cancellation: 'billing-cancellation-v1',
      entitlementEnforcement: 'billing-entitlement-enforcement-v1',
    })
  })
})

function isFeatureEnabledByEnvironmentVariable(
  environmentVariable: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const key = Object.entries(FEATURE_FLAGS).find(
    ([, flag]) => flag.environmentVariable === environmentVariable,
  )?.[0] as keyof typeof FEATURE_FLAGS | undefined
  return key === undefined ? false : isFeatureEnabled(key, environment)
}
