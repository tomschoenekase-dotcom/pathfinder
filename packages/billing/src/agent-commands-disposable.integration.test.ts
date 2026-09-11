import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { db, resolveProductEntitlement, withTenantIsolationBypass } from '@pathfinder/db'
import { executeApprovedBillingAgentCommand, proposeBillingAgentCommand } from './agent-commands'
import { parseBillingEnvironment } from './config'
import {
  createBillingAccessOverride,
  createManualBillingArrangement,
  createTenantCheckout,
} from './service'
import { recordTenantAddOnInterest, requestTenantCancellation } from './customer-requests'

const enabled =
  process.env.RUN_BILLING_COMMAND_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('billing commands on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('serializes grace effects and recovers committed effects without duplication', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `billing-race-${suffix}`
      const venueId = `billing-venue-${suffix}`
      const seasonalVenueId = `billing-seasonal-${suffix}`
      const identityId = `billing-agent-${suffix}`
      await db.tenant.create({
        data: { id: tenantId, slug: tenantId, name: 'Synthetic billing recovery' },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, slug: venueId, name: 'Synthetic museum' },
      })
      await db.venue.create({
        data: {
          id: seasonalVenueId,
          tenantId,
          slug: seasonalVenueId,
          name: 'Synthetic seasonal annex',
        },
      })
      const retainedPlaces = await Promise.all(
        [venueId, seasonalVenueId].map((coveredVenueId) =>
          db.place.create({
            data: {
              tenantId,
              venueId: coveredVenueId,
              name: `Retained place ${coveredVenueId}`,
              type: 'EXHIBIT',
              tags: ['retained'],
            },
          }),
        ),
      )
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: identityId,
          name: 'Synthetic billing worker',
          agentType: 'CUSTOMER_OPERATIONS',
          accessScope: 'VENUE',
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: 'fixture',
        },
      })
      const agreement = await createManualBillingArrangement({
        tenantId,
        actorId: 'fixture',
        mode: 'MANUAL_INVOICE',
        planKey: 'synthetic-custom-monthly',
        amountMinor: 5000n,
        venueIds: [venueId, seasonalVenueId],
        venueAmounts: [
          { venueId, amountMinor: 2500n },
          { venueId: seasonalVenueId, amountMinor: 2500n },
        ],
        reason: 'Disposable provider-dark billing race',
        client: db,
      })
      const environment = parseBillingEnvironment({
        NODE_ENV: 'test',
        RAILWAY_ENVIRONMENT: 'preview',
        DASHBOARD_URL: 'https://example.test',
      })
      const expiresAt = new Date(Date.now() + 86_400_000)
      const payload = {
        action: 'SET_GRACE_PERIOD' as const,
        agreementId: agreement.id,
        expiresAt: expiresAt.toISOString(),
        reference: 'SYNTHETIC',
        reason: 'Disposable approved grace',
      }
      const createCommand = async () => {
        const proposal = await proposeBillingAgentCommand({
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          payload,
          client: db,
        })
        await db.approvalDecision.create({
          data: {
            tenantId,
            venueId,
            approvalRequestId: proposal.command.approvalRequestId,
            decision: 'APPROVED',
            decidedByType: 'HUMAN',
            decidedById: 'fixture',
          },
        })
        return proposal.command
      }
      const first = await createCommand()
      const invoke = (commandId: string, client = db) =>
        executeApprovedBillingAgentCommand({
          tenantId,
          commandId,
          actorId: 'fixture',
          provider: {} as never,
          environment,
          client,
        })
      const race = await Promise.allSettled(Array.from({ length: 8 }, () => invoke(first.id)))
      expect(race.some((result) => result.status === 'fulfilled')).toBe(true)
      expect(await db.billingAccessOverride.count({ where: { tenantId } })).toBe(1)
      expect(
        await db.billingAgentCommand.findFirst({ where: { id: first.id, tenantId } }),
      ).toMatchObject({ status: 'COMPLETED' })

      const second = await createCommand()
      let failOnce = true
      const failingClient = new Proxy(db, {
        get(target, key) {
          if (key !== 'billingAgentCommand') return Reflect.get(target, key)
          return new Proxy(target.billingAgentCommand, {
            get(model, property) {
              if (property !== 'updateMany') return Reflect.get(model, property)
              return async (args: Parameters<typeof db.billingAgentCommand.updateMany>[0]) => {
                if (args?.data.status === 'COMPLETED' && failOnce) {
                  failOnce = false
                  throw new Error('synthetic completion-write failure')
                }
                return model.updateMany(args)
              }
            },
          })
        },
      })
      await expect(invoke(second.id, failingClient)).rejects.toThrow(
        'synthetic completion-write failure',
      )
      expect(await db.billingAccessOverride.count({ where: { tenantId } })).toBe(2)
      await invoke(second.id)
      expect(await db.billingAccessOverride.count({ where: { tenantId } })).toBe(2)

      const third = await createCommand()
      await db.billingAgentCommand.update({
        where: { id: third.id, tenantId },
        data: {
          status: 'EXECUTING',
          failureCode: 'EXECUTION_CLAIM_V2',
          updatedAt: new Date(Date.now() - 600_000),
        },
      })
      await invoke(third.id)
      expect(await db.billingAccessOverride.count({ where: { tenantId } })).toBe(3)
      const effects = await Promise.all(
        Array.from({ length: 8 }, () =>
          createBillingAccessOverride({
            tenantId,
            venueId,
            agreementId: agreement.id,
            actorId: 'fixture',
            effect: 'GRANT',
            kind: 'GRACE_PERIOD',
            expiresAt,
            reason: payload.reason,
            reference: payload.reference,
            idempotencyKey: 'independent-effect-race',
            client: db,
          }),
        ),
      )
      expect(new Set(effects.map((effect) => effect.id)).size).toBe(1)
      expect(await db.billingAccessOverride.count({ where: { tenantId } })).toBe(4)
      await expect(
        createBillingAccessOverride({
          tenantId,
          venueId,
          agreementId: agreement.id,
          actorId: 'fixture',
          effect: 'DENY',
          kind: 'GRACE_PERIOD',
          expiresAt,
          reason: payload.reason,
          reference: payload.reference,
          idempotencyKey: 'independent-effect-race',
          client: db,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        executeApprovedBillingAgentCommand({
          tenantId: 'wrong-tenant',
          commandId: first.id,
          actorId: 'fixture',
          provider: {} as never,
          environment,
          client: db,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(
        await db.auditLog.count({ where: { tenantId, action: 'billing.access-override.created' } }),
      ).toBe(4)
      // The same operation namespace serves interest and cancellation. A retry
      // must not reinterpret one as the other or silently change its scope.
      const interestInput = {
        tenantId,
        venueId,
        actorId: 'fixture',
        actorRole: 'OWNER',
        operationId: randomUUID(),
        featureKey: 'premium-voice',
        note: 'Synthetic optional interest',
        client: db,
      }
      const interest = await recordTenantAddOnInterest(interestInput)
      expect((await recordTenantAddOnInterest(interestInput)).request.id).toBe(interest.request.id)
      await expect(
        recordTenantAddOnInterest({ ...interestInput, venueId: null }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      const provider = { cancelSubscriptionAtPeriodEnd: vi.fn().mockResolvedValue(undefined) }
      const cancellationInput = {
        tenantId,
        actorId: 'fixture',
        actorRole: 'OWNER',
        operationId: interestInput.operationId,
        reason: 'Synthetic seasonal closure',
        provider: provider as never,
        client: db,
        environment: {
          ...environment,
          STRIPE_CANCELLATION_ENABLED: true,
          STRIPE_SECRET_KEY: 'sk_test_fixture',
        },
      }
      await expect(requestTenantCancellation(cancellationInput)).rejects.toMatchObject({
        code: 'CONFLICT',
      })
      expect(provider.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled()
      await db.commercialAgreement.update({
        where: { id: agreement.id },
        data: {
          stripeSubscriptionId: `sub_fixture_${suffix}`,
          stripeMode: 'TEST',
          stripeAccountId: 'acct_fixture',
          billingMode: 'STRIPE_SUBSCRIPTION',
        },
      })
      const exactInput = { ...cancellationInput, operationId: randomUUID() }
      const cancellation = await requestTenantCancellation(exactInput)
      expect(cancellation.request.status).toBe('COMPLETED')
      expect((await requestTenantCancellation(exactInput)).request.id).toBe(cancellation.request.id)
      await expect(
        requestTenantCancellation({ ...exactInput, reason: 'Different terms' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(provider.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(1)
      expect(await db.billingCustomerRequest.count({ where: { tenantId } })).toBe(2)

      const paidThroughAt = new Date(Date.now() + 7 * 86_400_000)
      await db.commercialAgreement.update({
        where: { id: agreement.id, tenantId },
        data: {
          status: 'CANCELED',
          stripeSubscriptionStatus: 'CANCELED',
          cancelAtPeriodEnd: true,
          currentPeriodEndsAt: paidThroughAt,
          cancellationEffectiveAt: paidThroughAt,
          endedAt: paidThroughAt,
        },
      })
      await db.billingAccount.update({
        where: { tenantId },
        data: { status: 'ENDED', paidThroughAt, updatedBy: 'fixture' },
      })
      await db.productPlanCapability.upsert({
        where: { planTier_capability: { planTier: 'free', capability: 'multi-venue' } },
        create: {
          planTier: 'free',
          capability: 'multi-venue',
          enabled: true,
          settings: {},
          createdBy: 'fixture',
          updatedBy: 'fixture',
        },
        update: { enabled: true, settings: {}, updatedBy: 'fixture' },
      })
      await db.tenantFeatureFlag.create({
        data: {
          tenantId,
          flagKey: 'billing-entitlement-enforcement-v1',
          enabled: true,
          metadata: {},
          setBy: 'fixture',
        },
      })
      const priorEnforcement = process.env.BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED
      const priorRecoveryPolicy = process.env.BILLING_RECOVERY_POLICY_APPROVED
      const priorGraceDays = process.env.BILLING_GRACE_PERIOD_DAYS
      process.env.BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED = 'true'
      process.env.BILLING_RECOVERY_POLICY_APPROVED = 'true'
      process.env.BILLING_GRACE_PERIOD_DAYS = '14'
      try {
        await expect(
          resolveProductEntitlement({
            client: db,
            tenantId,
            venueId: seasonalVenueId,
            capability: 'multi-venue',
            now: new Date(),
          }),
        ).resolves.toMatchObject({ enabled: true, source: 'PLAN' })
        await expect(
          resolveProductEntitlement({
            client: db,
            tenantId,
            venueId: seasonalVenueId,
            capability: 'multi-venue',
            now: new Date(paidThroughAt.getTime() + 1),
          }),
        ).resolves.toMatchObject({
          enabled: false,
          source: 'BILLING_POLICY',
          settings: { accessState: 'ENDED' },
        })
      } finally {
        if (priorEnforcement === undefined)
          delete process.env.BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED
        else process.env.BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED = priorEnforcement
        if (priorRecoveryPolicy === undefined) delete process.env.BILLING_RECOVERY_POLICY_APPROVED
        else process.env.BILLING_RECOVERY_POLICY_APPROVED = priorRecoveryPolicy
        if (priorGraceDays === undefined) delete process.env.BILLING_GRACE_PERIOD_DAYS
        else process.env.BILLING_GRACE_PERIOD_DAYS = priorGraceDays
      }

      const checkoutProvider = {
        createCustomer: vi.fn().mockResolvedValue({ id: `cus_reactivation_${suffix}` }),
        createCheckoutSession: vi.fn().mockResolvedValue({
          id: `cs_reactivation_${suffix}`,
          url: 'https://checkout.stripe.test/reactivation',
          expiresAt: new Date(Date.now() + 30 * 60_000),
        }),
      }
      const reactivationInput = {
        tenantId,
        actorId: 'fixture',
        actorRole: 'PLATFORM_ADMIN',
        planKey: 'torchiko_pilot_test',
        venueIds: [venueId, seasonalVenueId],
        operationKey: `seasonal-reactivation-${suffix}`,
        negotiatedTerms: {
          amountMinor: 5000n,
          venueAmounts: [
            { venueId, amountMinor: 2500n },
            { venueId: seasonalVenueId, amountMinor: 2500n },
          ],
          currency: 'usd',
          interval: 'month',
          intervalCount: 1,
          reason: 'Approved provider-dark seasonal reactivation fixture',
          reference: `QUOTE-REACTIVATION-${suffix}`,
        },
        provider: checkoutProvider as never,
        environment: {
          ...environment,
          STRIPE_CHECKOUT_ENABLED: true,
          STRIPE_SECRET_KEY: 'sk_test_fixture',
          STRIPE_CATALOG_JSON: JSON.stringify({
            catalogVersion: 1,
            plans: [
              {
                key: 'torchiko_pilot_test',
                version: 1,
                displayName: 'Pilot test',
                description: 'Provider-dark approved quote fixture',
                providerMode: 'test',
                stripeProductId: 'prod_test',
                stripePriceId: 'price_test',
                currency: 'usd',
                interval: 'month',
                unitAmount: 2500,
                minimumVenueCount: 1,
                maximumVenueCount: null,
                newSalesEnabled: true,
                portalChangesEnabled: false,
              },
            ],
          }),
        },
        client: db,
      } satisfies Parameters<typeof createTenantCheckout>[0]
      const reactivationRace = await Promise.allSettled([
        createTenantCheckout(reactivationInput),
        createTenantCheckout({
          ...reactivationInput,
          operationKey: `competing-seasonal-reactivation-${suffix}`,
        }),
      ])
      expect(checkoutProvider.createCheckoutSession).toHaveBeenCalledTimes(1)
      const reactivation = reactivationRace.find(
        (
          result,
        ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createTenantCheckout>>> =>
          result.status === 'fulfilled',
      )?.value
      expect(reactivationRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(reactivationRace.filter((result) => result.status === 'rejected')).toHaveLength(1)
      expect(reactivation).toBeDefined()
      if (!reactivation) throw new Error('Expected one reviewed reactivation reservation.')
      expect(reactivation.replayed).toBe(false)
      expect(checkoutProvider.createCheckoutSession).toHaveBeenCalledTimes(1)
      const baseAgreements = await db.commercialAgreement.findMany({
        where: { tenantId, isBase: true },
        include: { coveredVenues: { where: { tenantId }, orderBy: { venueId: 'asc' } } },
      })
      expect(baseAgreements).toHaveLength(1)
      expect(baseAgreements[0]).toMatchObject({
        status: 'PENDING',
        commercialReference: `QUOTE-REACTIVATION-${suffix}`,
        coveredVenueCount: 2,
      })
      expect(baseAgreements[0]?.coveredVenues.map((row) => row.venueId).sort()).toEqual(
        [venueId, seasonalVenueId].sort(),
      )
      expect(
        await db.commercialAgreement.findFirstOrThrow({ where: { id: agreement.id, tenantId } }),
      ).toMatchObject({ isBase: false, status: 'ENDED' })
      expect(
        await db.place.findMany({
          where: { tenantId, id: { in: retainedPlaces.map((place) => place.id) } },
          orderBy: { id: 'asc' },
        }),
      ).toHaveLength(2)

      const firstCheckoutTenantId = `billing-first-${suffix}`
      const firstCheckoutVenueId = `billing-first-venue-${suffix}`
      await db.tenant.create({
        data: {
          id: firstCheckoutTenantId,
          slug: firstCheckoutTenantId,
          name: 'First Checkout concurrency fixture',
        },
      })
      await db.venue.create({
        data: {
          id: firstCheckoutVenueId,
          tenantId: firstCheckoutTenantId,
          slug: firstCheckoutVenueId,
          name: 'First Checkout venue',
        },
      })
      const firstCheckoutProvider = {
        createCustomer: vi.fn().mockResolvedValue({ id: `cus_first_${suffix}` }),
        createCheckoutSession: vi.fn().mockResolvedValue({
          id: `cs_first_${suffix}`,
          url: 'https://checkout.stripe.test/first',
          expiresAt: new Date(Date.now() + 30 * 60_000),
        }),
      }
      const firstCheckoutInput = {
        ...reactivationInput,
        tenantId: firstCheckoutTenantId,
        venueIds: [firstCheckoutVenueId],
        operationKey: `first-checkout-${suffix}`,
        negotiatedTerms: {
          ...reactivationInput.negotiatedTerms,
          amountMinor: 2500n,
          venueAmounts: [{ venueId: firstCheckoutVenueId, amountMinor: 2500n }],
          reference: `QUOTE-FIRST-${suffix}`,
        },
        provider: firstCheckoutProvider as never,
      } satisfies Parameters<typeof createTenantCheckout>[0]
      const sameOperationRace = await Promise.all([
        createTenantCheckout(firstCheckoutInput),
        createTenantCheckout(firstCheckoutInput),
      ])
      expect(sameOperationRace.filter((result) => result.replayed === false)).toHaveLength(1)
      expect(sameOperationRace.filter((result) => result.replayed === true)).toHaveLength(1)
      await expect(
        createTenantCheckout({
          ...firstCheckoutInput,
          operationKey: `competing-first-checkout-${suffix}`,
        }),
      ).resolves.toMatchObject({ replayed: true, sessionId: `cs_first_${suffix}` })
      expect(firstCheckoutProvider.createCheckoutSession).toHaveBeenCalledTimes(1)
      expect(
        await db.commercialAgreement.count({
          where: { tenantId: firstCheckoutTenantId, isBase: true },
        }),
      ).toBe(1)
    })
  })
})
