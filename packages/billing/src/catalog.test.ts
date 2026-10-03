import { describe, expect, it } from 'vitest'

import { findApprovedPlan, liveSaleBlocker, parseBillingCatalog } from './catalog'

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

describe('live-mode sale guard', () => {
  const livePlan = {
    key: 'torchiko_venue_monthly',
    version: 1,
    displayName: 'Torchiko venue guide',
    description: 'Monthly venue guide subscription.',
    providerMode: 'live',
    stripeProductId: 'prod_live1',
    stripePriceId: 'price_live1',
    currency: 'usd',
    interval: 'month',
    unitAmount: 1500,
    newSalesEnabled: true,
  }
  const parse = (plan: Record<string, unknown>) =>
    parseBillingCatalog(JSON.stringify({ catalogVersion: 1, plans: [plan] }))
  const approval = { approvedAt: '2026-10-02T00:00:00Z', approvalReference: 'owner-approval-1' }

  it('refuses a live plan with no recorded owner approval', () => {
    expect(() => parse(livePlan)).toThrow(/explicit recorded owner approval/u)
  })

  it.each([
    ['display name', { displayName: 'Torchiko pilot test fixture' }],
    ['description', { description: 'Not for live sales' }],
    ['metadata', { metadata: { purpose: 'sandbox fixture' } }],
  ])('refuses a live plan labelled as a fixture via its %s even when approved', (_label, extra) => {
    expect(() => parse({ ...livePlan, ...extra, liveApproval: approval })).toThrow(
      /test fixture cannot be used for live Checkout/u,
    )
  })

  it('allows an approved, unlabelled live plan and resolves it for a new sale', () => {
    const catalog = parse({ ...livePlan, liveApproval: approval })
    expect(
      findApprovedPlan({
        catalog,
        key: livePlan.key,
        providerMode: 'live',
        venueCount: 1,
        forNewSale: true,
      }).stripePriceId,
    ).toBe('price_live1')
  })

  it('re-checks the guard on a hand-built catalog and never blocks test mode', () => {
    const catalog = parse({ ...livePlan, liveApproval: approval })
    const unapproved = {
      ...catalog,
      plans: catalog.plans.map((plan) => ({ ...plan, liveApproval: undefined })),
    }
    expect(() =>
      findApprovedPlan({
        catalog: unapproved,
        key: livePlan.key,
        providerMode: 'live',
        venueCount: 1,
        forNewSale: true,
      }),
    ).toThrow(/not available/u)
    const fixture = parseBillingCatalog(catalogJson).plans[0]!
    expect(liveSaleBlocker(fixture)).toBeNull()
  })
})
