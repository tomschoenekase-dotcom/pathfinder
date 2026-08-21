import { describe, expect, it } from 'vitest'

import { findApprovedPlan, parseBillingCatalog } from './catalog'

const catalogJson = JSON.stringify({
  catalogVersion: 1,
  plans: [
    {
      key: 'torchiko_pilot_test',
      version: 1,
      displayName: 'Torchiko pilot test fixture',
      description: 'Sandbox-only recurring billing fixture; not an approved production price.',
      providerMode: 'test',
      stripeProductId: 'prod_TestFixture',
      stripePriceId: 'price_TestFixture',
      currency: 'usd',
      interval: 'month',
      unitAmount: 1500,
      minimumVenueCount: 1,
      maximumVenueCount: 3,
      newSalesEnabled: true,
      portalChangesEnabled: false,
    },
  ],
})

describe('billing catalog', () => {
  it('resolves an internal plan without accepting a browser price ID', () => {
    const catalog = parseBillingCatalog(catalogJson)
    expect(
      findApprovedPlan({
        catalog,
        key: 'torchiko_pilot_test',
        providerMode: 'test',
        venueCount: 2,
        forNewSale: true,
      }),
    ).toMatchObject({ stripePriceId: 'price_TestFixture', unitAmount: 1500 })
  })

  it('forbids unmistakable test fixtures in live mappings', () => {
    expect(() =>
      parseBillingCatalog(
        JSON.stringify({
          catalogVersion: 1,
          plans: [
            {
              key: 'torchiko_pilot_test',
              version: 1,
              displayName: 'Pilot',
              description: 'Fixture',
              providerMode: 'live',
              stripeProductId: 'prod_live',
              stripePriceId: 'price_live',
              currency: 'usd',
              interval: 'month',
              intervalCount: 1,
              unitAmount: 1500,
              minimumVenueCount: 1,
              maximumVenueCount: null,
              newSalesEnabled: true,
              portalChangesEnabled: false,
              metadata: {},
            },
          ],
        }),
      ),
    ).toThrow(/Test fixture plan keys/u)
  })

  it('rejects a plan for the wrong mode or venue count', () => {
    const catalog = parseBillingCatalog(catalogJson)
    expect(() =>
      findApprovedPlan({
        catalog,
        key: 'torchiko_pilot_test',
        providerMode: 'live',
        venueCount: 1,
        forNewSale: true,
      }),
    ).toThrow(/not available/u)
    expect(() =>
      findApprovedPlan({
        catalog,
        key: 'torchiko_pilot_test',
        providerMode: 'test',
        venueCount: 4,
        forNewSale: true,
      }),
    ).toThrow(/not available/u)
  })
})
