import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { createManualBillingArrangement } from './service'

const enabled =
  process.env.RUN_MULTI_VENUE_BILLING_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('multi-venue price breakdown disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('persists an exact provider-dark breakdown and rejects database tampering', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-price-${suffix}`
      const venueA = `venue-price-a-${suffix}`
      const venueB = `venue-price-b-${suffix}`

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic multi-venue customer', slug: tenantId },
      })
      await db.venue.createMany({
        data: [
          { id: venueA, tenantId, name: 'Synthetic flagship', slug: venueA },
          { id: venueB, tenantId, name: 'Synthetic second venue', slug: venueB },
        ],
      })

      const agreement = await createManualBillingArrangement({
        tenantId,
        actorId: 'integration-operator',
        mode: 'MANUAL_INVOICE',
        planKey: 'founder-approved-custom-monthly',
        amountMinor: 5_000n,
        venueAmounts: [
          { venueId: venueA, amountMinor: 3_000n },
          { venueId: venueB, amountMinor: 2_000n },
        ],
        venueIds: [venueA, venueB],
        reason: 'Synthetic provider-dark invariant proof.',
        reference: 'SYNTHETIC-QUOTE',
        client: db,
      })

      expect(
        await db.commercialAgreement.findUnique({
          where: { id: agreement.id },
          include: { coveredVenues: { orderBy: { venueId: 'asc' } } },
        }),
      ).toMatchObject({
        agreedAmountMinor: 5_000n,
        venuePriceBreakdownComplete: true,
        currency: 'usd',
        stripeMode: null,
        stripeSubscriptionId: null,
        coveredVenues: [
          { venueId: venueA, agreedAmountMinor: 3_000n },
          { venueId: venueB, agreedAmountMinor: 2_000n },
        ],
      })
      expect(
        await Promise.all([
          db.billingCheckoutAttempt.count({ where: { tenantId } }),
          db.billingInvoiceProjection.count({ where: { tenantId } }),
          db.stripeWebhookReceipt.count(),
        ]),
      ).toEqual([0, 0, 0])

      await expect(
        db.$transaction(async (tx) => {
          await tx.commercialAgreementVenue.update({
            where: {
              tenantId_commercialAgreementId_venueId: {
                tenantId,
                commercialAgreementId: agreement.id,
                venueId: venueB,
              },
            },
            data: { agreedAmountMinor: 1_999n },
          })
        }),
      ).rejects.toThrow(/venue price breakdown must equal the agreement total/u)

      await expect(
        db.$transaction(async (tx) => {
          await tx.commercialAgreement.update({
            where: { id: agreement.id, tenantId },
            data: { venuePriceBreakdownComplete: false },
          })
        }),
      ).rejects.toThrow(/venue price components require an explicitly complete breakdown/u)
    })
  })
})
