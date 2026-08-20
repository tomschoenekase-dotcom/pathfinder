import { describe, expect, it } from 'vitest'

import {
  PRODUCT_CAPABILITY_IDS,
  PRODUCT_CAPABILITY_REGISTRY,
  ProductEntitlementDecision,
} from './product-entitlements'

describe('product entitlement contracts', () => {
  it('keeps the capability registry closed and complete', () => {
    expect(Object.keys(PRODUCT_CAPABILITY_REGISTRY)).toEqual(PRODUCT_CAPABILITY_IDS)
  })

  it('requires an auditable resolution source', () => {
    expect(
      ProductEntitlementDecision.parse({
        capability: 'voice',
        enabled: false,
        source: 'KILL_SWITCH',
        sourceId: null,
        planTier: 'launch',
        settings: {},
        validUntil: null,
      }),
    ).toMatchObject({ capability: 'voice', enabled: false })
  })
})
