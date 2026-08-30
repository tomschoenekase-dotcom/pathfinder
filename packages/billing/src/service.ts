import { createHash, randomUUID } from 'node:crypto'

import type Stripe from 'stripe'

import {
  db,
  publishOperationalEvent,
  publishPlatformOperationalEvent,
  withTenantIsolationBypass,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { findApprovedPlan, parseBillingCatalog } from './catalog'
import {
  billingCapabilityEnabled,
  parseBillingEnvironment,
  type BillingEnvironment,
} from './config'
import { customerPortalPolicy, evaluateBillingAccess } from './policy'
import { projectStripeInvoice, projectStripeSubscription } from './projections'
import type { BillingProvider } from './provider'
import {
  isSupportedStripeEventType,
  normalizedStripeObjectReference,
  sanitizedStripeEventSummary,
} from './webhook-events'

type DbClient = typeof db

export class BillingServiceError extends Error {
  constructor(
    readonly code:
      | 'DISABLED'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'FORBIDDEN'
      | 'INVALID_PROVIDER_EVENT'
      | 'UNSAFE_PORTAL_POLICY',
    message: string,
  ) {
    super(message)
    this.name = 'BillingServiceError'
  }
}

export type VenuePriceComponent = {
  venueId: string
  amountMinor: bigint
}

export function normalizeVenuePriceBreakdown(params: {
  venueIds: string[]
  totalAmountMinor: bigint | null
  venueAmounts?: VenuePriceComponent[]
}): VenuePriceComponent[] {
  const venueIds = [...new Set(params.venueIds)]
  const supplied = params.venueAmounts ?? []
  if (params.totalAmountMinor === null) {
    if (supplied.length) {
      throw new BillingServiceError(
        'CONFLICT',
        'Venue price components require an agreement total.',
      )
    }
    return []
  }
  if (params.totalAmountMinor <= 0n || params.totalAmountMinor > 999_999_999_999n) {
    throw new BillingServiceError('CONFLICT', 'The negotiated amount is outside allowed bounds.')
  }
  if (!supplied.length) {
    if (venueIds.length !== 1) {
      throw new BillingServiceError(
        'CONFLICT',
        'A multi-venue negotiated total requires one approved amount for every covered venue.',
      )
    }
    return [{ venueId: venueIds[0]!, amountMinor: params.totalAmountMinor }]
  }
  const componentIds = supplied.map((component) => component.venueId)
  if (new Set(componentIds).size !== componentIds.length) {
    throw new BillingServiceError(
      'CONFLICT',
      'A covered venue may appear only once in a price breakdown.',
    )
  }
  if (
    supplied.length !== venueIds.length ||
    supplied.some((component) => !venueIds.includes(component.venueId))
  ) {
    throw new BillingServiceError(
      'CONFLICT',
      'The price breakdown must match the covered venues exactly.',
    )
  }
  if (
    supplied.some(
      (component) => component.amountMinor <= 0n || component.amountMinor > 999_999_999_999n,
    )
  ) {
    throw new BillingServiceError('CONFLICT', 'Each venue amount must be positive and bounded.')
  }
  if (
    supplied.reduce((sum, component) => sum + component.amountMinor, 0n) !== params.totalAmountMinor
  ) {
    throw new BillingServiceError(
      'CONFLICT',
      'The venue price breakdown must equal the approved agreement total.',
    )
  }
  return venueIds.map((venueId) => supplied.find((component) => component.venueId === venueId)!)
}

function mode(environment: BillingEnvironment): 'TEST' | 'LIVE' {
  return environment.STRIPE_MODE === 'live' ? 'LIVE' : 'TEST'
}

export function isNewerProviderState(input: {
  incomingAt: Date
  incomingEventId: string
  appliedAt: Date | null
  appliedEventId: string | null
}): boolean {
  if (!input.appliedAt) return true
  if (input.incomingAt.getTime() !== input.appliedAt.getTime())
    return input.incomingAt > input.appliedAt
  return !input.appliedEventId || input.incomingEventId.localeCompare(input.appliedEventId) > 0
}

export async function getTenantBillingOverview(params: {
  tenantId: string
  client?: DbClient
  environment?: BillingEnvironment
}) {
  const client = params.client ?? db
  const environment = params.environment ?? parseBillingEnvironment()
  const [account, venues] = await Promise.all([
    client.billingAccount.findUnique({
      where: { tenantId: params.tenantId },
      include: {
        commercialAgreements: {
          where: { tenantId: params.tenantId },
          include: {
            coveredVenues: {
              where: { tenantId: params.tenantId },
              include: { venue: { select: { id: true, name: true } } },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        invoiceProjections: {
          where: { tenantId: params.tenantId },
          orderBy: { createdAt: 'desc' },
          take: 12,
        },
        checkoutAttempts: {
          where: {
            tenantId: params.tenantId,
            status: 'CREATED',
            expiresAt: { gt: new Date() },
            stripeCheckoutUrl: { not: null },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        accessOverrides: {
          where: { tenantId: params.tenantId, expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
        },
        reconciliationRuns: {
          where: { tenantId: params.tenantId },
          orderBy: { startedAt: 'desc' },
          take: 5,
        },
        eventApplications: {
          where: { tenantId: params.tenantId },
          orderBy: { providerCreatedAt: 'desc' },
          take: 50,
        },
        customerRequests: {
          where: { tenantId: params.tenantId },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        agentCommands: {
          where: { tenantId: params.tenantId },
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            approvalRequest: {
              select: {
                id: true,
                expiresAt: true,
                decision: { select: { decision: true, decidedByType: true, createdAt: true } },
              },
            },
          },
        },
      },
    }),
    client.venue.findMany({
      where: { tenantId: params.tenantId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])
  const catalog = parseBillingCatalog(environment.STRIPE_CATALOG_JSON)
    .plans.filter((plan) => plan.providerMode === environment.STRIPE_MODE && plan.newSalesEnabled)
    .map((plan) => ({
      key: plan.key,
      version: plan.version,
      displayName: plan.displayName,
      description: plan.description,
      currency: plan.currency,
      unitAmount: plan.unitAmount,
      interval: plan.interval,
      intervalCount: plan.intervalCount,
      minimumVenueCount: plan.minimumVenueCount,
      maximumVenueCount: plan.maximumVenueCount,
    }))
  if (!account) {
    return {
      enabled: billingCapabilityEnabled('ui', environment),
      capabilities: {
        checkout: billingCapabilityEnabled('checkout', environment),
        portal: false,
        cancellation: false,
        addOnInterest: billingCapabilityEnabled('ui', environment),
      },
      catalog,
      venues,
      account: null,
      access: null,
    }
  }
  const agreement =
    account.commercialAgreements.find((candidate) => candidate.isBase) ??
    account.commercialAgreements[0]
  const override = account.accessOverrides[0]
  const access = agreement
    ? evaluateBillingAccess({
        billingMode: agreement.billingMode,
        arrangementStatus: agreement.status,
        providerSubscriptionStatus: (agreement.stripeSubscriptionStatus ?? null) as Exclude<
          Parameters<typeof evaluateBillingAccess>[0]['providerSubscriptionStatus'],
          undefined
        >,
        paidThrough: account.paidThroughAt ?? agreement.currentPeriodEndsAt,
        accessStartsAt: agreement.accessStartsAt,
        accessEndsAt: agreement.accessEndsAt,
        graceEndsAt: account.gracePeriodEndsAt,
        cancelAtPeriodEnd: agreement.cancelAtPeriodEnd,
        override: override
          ? {
              reason: override.reason,
              expiresAt: override.expiresAt,
              grantsAccess: override.effect === 'GRANT',
            }
          : null,
      })
    : null
  return {
    enabled: billingCapabilityEnabled('ui', environment),
    capabilities: {
      checkout: billingCapabilityEnabled('checkout', environment),
      portal: billingCapabilityEnabled('portal', environment),
      cancellation: billingCapabilityEnabled('cancellation', environment),
      addOnInterest: billingCapabilityEnabled('ui', environment),
    },
    catalog,
    venues,
    account,
    access,
  }
}

export async function createTenantCheckout(params: {
  tenantId: string
  actorId: string
  actorRole: string
  planKey: string
  planVersion?: number
  venueIds: string[]
  operationKey?: string
  replaceManualArrangement?: boolean
  negotiatedTerms?: {
    amountMinor: bigint
    venueAmounts?: VenuePriceComponent[]
    currency: string
    interval: 'month' | 'year'
    intervalCount: number
    reason: string
    reference: string
  }
  provider: BillingProvider
  environment?: BillingEnvironment
  client?: DbClient
}) {
  const client = params.client ?? db
  const environment = params.environment ?? parseBillingEnvironment()
  if (!billingCapabilityEnabled('checkout', environment)) {
    throw new BillingServiceError('DISABLED', 'Subscription Checkout is disabled.')
  }
  const venueIds = [...new Set(params.venueIds)]
  if (!venueIds.length)
    throw new BillingServiceError('NOT_FOUND', 'At least one venue is required.')
  const plan = findApprovedPlan({
    catalog: parseBillingCatalog(environment.STRIPE_CATALOG_JSON),
    key: params.planKey,
    ...(params.planVersion === undefined ? {} : { version: params.planVersion }),
    providerMode: environment.STRIPE_MODE,
    venueCount: venueIds.length,
    forNewSale: true,
  })
  const negotiatedTerms = params.negotiatedTerms
  if (negotiatedTerms && params.actorRole !== 'PLATFORM_ADMIN') {
    throw new BillingServiceError(
      'FORBIDDEN',
      'Only a platform administrator may approve negotiated Stripe pricing.',
    )
  }
  if (
    negotiatedTerms &&
    (negotiatedTerms.interval !== 'month' || negotiatedTerms.intervalCount !== 1)
  ) {
    throw new BillingServiceError(
      'CONFLICT',
      'Launch quotes must use monthly recurring billing; contractual commitments remain separate.',
    )
  }
  const agreedAmountMinor =
    negotiatedTerms?.amountMinor ?? BigInt(plan.unitAmount * venueIds.length)
  if (agreedAmountMinor <= 0n || agreedAmountMinor > 999_999_999_999n) {
    throw new BillingServiceError('CONFLICT', 'The negotiated amount is outside allowed bounds.')
  }
  const providerUnitAmount = Number(agreedAmountMinor)
  if (!Number.isSafeInteger(providerUnitAmount)) {
    throw new BillingServiceError('CONFLICT', 'The negotiated amount cannot be represented safely.')
  }
  const billingQuantity = negotiatedTerms ? 1 : venueIds.length
  const billingCurrency = negotiatedTerms?.currency ?? plan.currency
  const billingInterval = negotiatedTerms?.interval ?? plan.interval
  const billingIntervalCount = negotiatedTerms?.intervalCount ?? plan.intervalCount
  const venuePriceBreakdown = negotiatedTerms
    ? normalizeVenuePriceBreakdown({
        venueIds,
        totalAmountMinor: agreedAmountMinor,
        ...(negotiatedTerms.venueAmounts ? { venueAmounts: negotiatedTerms.venueAmounts } : {}),
      })
    : []
  const operationKey = params.operationKey ?? randomUUID()
  const reserved = await client.$transaction(async (tx) => {
    const replay = await tx.billingCheckoutAttempt.findFirst({
      where: { tenantId: params.tenantId, operationKey },
    })
    if (replay) return { replay, tenant: null, account: null, agreement: null, replacementId: null }
    if (!negotiatedTerms) {
      throw new BillingServiceError(
        'CONFLICT',
        'Every launch checkout requires a platform-admin-approved custom quote.',
      )
    }
    const tenant = await tx.tenant.findUnique({
      where: { id: params.tenantId },
      select: { id: true, name: true },
    })
    if (!tenant) throw new BillingServiceError('NOT_FOUND', 'Tenant not found.')
    const venues = await tx.venue.findMany({
      where: { tenantId: params.tenantId, id: { in: venueIds } },
      select: { id: true },
    })
    if (venues.length !== venueIds.length) {
      throw new BillingServiceError(
        'FORBIDDEN',
        'Every covered venue must belong to the authenticated tenant.',
      )
    }
    const current = await tx.commercialAgreement.findFirst({
      where: {
        tenantId: params.tenantId,
        isBase: true,
        status: { in: ['PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED'] },
      },
    })
    if (
      current?.status === 'PENDING' &&
      current.billingMode === 'STRIPE_SUBSCRIPTION' &&
      !current.stripeSubscriptionId &&
      current.internalPlanKey === plan.key &&
      current.internalPlanVersion === plan.version &&
      current.coveredVenueCount === venueIds.length &&
      current.quantity === billingQuantity &&
      current.agreedAmountMinor === agreedAmountMinor &&
      current.venuePriceBreakdownComplete === Boolean(negotiatedTerms) &&
      current.currency === billingCurrency &&
      current.billingInterval === (billingInterval === 'year' ? 'YEAR' : 'MONTH') &&
      current.billingIntervalCount === billingIntervalCount &&
      current.stripePriceId === (negotiatedTerms ? null : plan.stripePriceId)
    ) {
      const coveredVenues = await tx.commercialAgreementVenue.findMany({
        where: {
          tenantId: params.tenantId,
          commercialAgreementId: current.id,
          venueId: { in: venueIds },
        },
        select: { venueId: true, agreedAmountMinor: true },
      })
      const coverageMatches = negotiatedTerms
        ? coveredVenues.length === venuePriceBreakdown.length &&
          venuePriceBreakdown.every((component) =>
            coveredVenues.some(
              (coverage) =>
                coverage.venueId === component.venueId &&
                coverage.agreedAmountMinor === component.amountMinor,
            ),
          )
        : coveredVenues.length === venueIds.length
      if (coverageMatches) {
        const account = await tx.billingAccount.findUnique({ where: { tenantId: params.tenantId } })
        if (!account) throw new BillingServiceError('NOT_FOUND', 'Billing account not found.')
        const existingAttempt = await tx.billingCheckoutAttempt.findFirst({
          where: {
            tenantId: params.tenantId,
            commercialAgreementId: current.id,
            status: 'CREATED',
            expiresAt: { gt: new Date() },
            stripeCheckoutUrl: { not: null },
          },
          orderBy: { createdAt: 'desc' },
        })
        if (existingAttempt) {
          return {
            replay: existingAttempt,
            tenant: null,
            account: null,
            agreement: null,
            replacementId: null,
          }
        }
        const attempt = await tx.billingCheckoutAttempt.create({
          data: {
            tenantId: params.tenantId,
            billingAccountId: account.id,
            commercialAgreementId: current.id,
            operationKey,
            requestedPlanKey: plan.key,
            requestedPlanVersion: plan.version,
            requestedQuantity: billingQuantity,
            stripeMode: mode(environment),
            stripeAccountId: environment.STRIPE_ACCOUNT_NAMESPACE,
            initiatedBy: params.actorId,
          },
        })
        return { replay: attempt, tenant, account, agreement: current, replacementId: null }
      }
    }
    if (
      current &&
      (!params.replaceManualArrangement ||
        current.billingMode === 'STRIPE_SUBSCRIPTION' ||
        current.billingMode === 'STRIPE_INVOICE')
    ) {
      throw new BillingServiceError('CONFLICT', 'A current base subscription already exists.')
    }
    const account = await tx.billingAccount.upsert({
      where: { tenantId: params.tenantId },
      create: {
        tenantId: params.tenantId,
        displayNameSnapshot: tenant.name,
        billingMode: 'STRIPE_SUBSCRIPTION',
        status: 'PENDING',
        stripeMode: mode(environment),
        stripeAccountId: environment.STRIPE_ACCOUNT_NAMESPACE,
        createdBy: params.actorId,
        updatedBy: params.actorId,
      },
      update: { billingMode: 'STRIPE_SUBSCRIPTION', updatedBy: params.actorId },
    })
    const agreement = await tx.commercialAgreement.create({
      data: {
        tenantId: params.tenantId,
        billingAccountId: account.id,
        isBase: !current,
        internalPlanKey: plan.key,
        internalPlanVersion: plan.version,
        status: 'PENDING',
        billingMode: 'STRIPE_SUBSCRIPTION',
        billingInterval: billingInterval === 'year' ? 'YEAR' : 'MONTH',
        billingIntervalCount,
        quantity: billingQuantity,
        coveredVenueCount: venueIds.length,
        agreedAmountMinor,
        venuePriceBreakdownComplete: Boolean(negotiatedTerms),
        currency: billingCurrency,
        stripeMode: mode(environment),
        stripeAccountId: environment.STRIPE_ACCOUNT_NAMESPACE,
        stripeProductId: plan.stripeProductId,
        stripePriceId: negotiatedTerms ? null : plan.stripePriceId,
        commercialReference: negotiatedTerms?.reference ?? null,
        startsAt: new Date(),
        createdBy: params.actorId,
        updatedBy: params.actorId,
        coveredVenues: {
          create: venueIds.map((venueId) => ({
            venueId,
            agreedAmountMinor:
              venuePriceBreakdown.find((component) => component.venueId === venueId)?.amountMinor ??
              null,
            createdBy: params.actorId,
          })),
        },
      },
    })
    const attempt = await tx.billingCheckoutAttempt.create({
      data: {
        tenantId: params.tenantId,
        billingAccountId: account.id,
        commercialAgreementId: agreement.id,
        operationKey,
        requestedPlanKey: plan.key,
        requestedPlanVersion: plan.version,
        requestedQuantity: billingQuantity,
        stripeMode: mode(environment),
        stripeAccountId: environment.STRIPE_ACCOUNT_NAMESPACE,
        initiatedBy: params.actorId,
      },
    })
    if (negotiatedTerms) {
      await writeAuditLogStrict(
        {
          tenantId: params.tenantId,
          actorId: params.actorId,
          actorRole: params.actorRole,
          action: 'billing.negotiated-price.approved',
          targetType: 'CommercialAgreement',
          targetId: agreement.id,
          afterState: {
            planKey: plan.key,
            planVersion: plan.version,
            amountMinor: agreedAmountMinor.toString(),
            currency: billingCurrency,
            interval: billingInterval,
            intervalCount: billingIntervalCount,
            coveredVenueCount: venueIds.length,
            venueAmounts: venuePriceBreakdown.map((component) => ({
              venueId: component.venueId,
              amountMinor: component.amountMinor.toString(),
            })),
            reference: negotiatedTerms.reference,
            reason: negotiatedTerms.reason,
            stripeMode: environment.STRIPE_MODE,
          },
        },
        tx,
      )
    }
    return { replay: attempt, tenant, account, agreement, replacementId: current?.id ?? null }
  })
  if (!reserved.tenant || !reserved.account || !reserved.agreement) {
    return {
      attemptId: reserved.replay.id,
      sessionId: reserved.replay.stripeCheckoutSessionId,
      url: reserved.replay.stripeCheckoutUrl ?? null,
      replayed: true,
    }
  }
  let customerId = reserved.account.stripeCustomerId
  if (!customerId) {
    const customer = await params.provider.createCustomer({
      tenantId: params.tenantId,
      name: reserved.tenant.name,
      email: reserved.account.billingEmail,
      operationId: `customer:${params.tenantId}:${operationKey}`,
    })
    customerId = customer.id
    await client.billingAccount.update({
      where: { id: reserved.account.id, tenantId: params.tenantId },
      data: { stripeCustomerId: customerId, updatedBy: params.actorId },
    })
  }
  const origin = new URL(environment.DASHBOARD_URL).origin
  const session = await params.provider.createCheckoutSession({
    customerId,
    lineItem: negotiatedTerms
      ? {
          kind: 'negotiated',
          productId: plan.stripeProductId,
          unitAmount: providerUnitAmount,
          currency: billingCurrency,
          interval: billingInterval,
          intervalCount: billingIntervalCount,
        }
      : { kind: 'fixed', priceId: plan.stripePriceId, quantity: billingQuantity },
    successUrl: `${origin}/payment/success?attempt=${encodeURIComponent(reserved.replay.id)}`,
    cancelUrl: `${origin}/payment/canceled?attempt=${encodeURIComponent(reserved.replay.id)}`,
    tenantId: params.tenantId,
    agreementId: reserved.agreement.id,
    operationId: operationKey,
    customerEmail: reserved.account.billingEmail,
  })
  await client.$transaction(async (tx) => {
    if (reserved.replacementId) {
      await tx.commercialAgreement.update({
        where: { id: reserved.replacementId, tenantId: params.tenantId },
        data: { isBase: false, status: 'ENDED', endedAt: new Date(), updatedBy: params.actorId },
      })
      await tx.commercialAgreement.update({
        where: { id: reserved.agreement.id, tenantId: params.tenantId },
        data: { isBase: true, updatedBy: params.actorId },
      })
    }
    await tx.billingCheckoutAttempt.update({
      where: { id: reserved.replay.id, tenantId: params.tenantId },
      data: {
        stripeCheckoutSessionId: session.id,
        stripeCheckoutUrl: session.url,
        status: 'CREATED',
        providerCreatedAt: new Date(),
        expiresAt: session.expiresAt,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: params.tenantId,
        actorId: params.actorId,
        actorRole: params.actorRole,
        action: 'billing.checkout.created',
        targetType: 'BillingCheckoutAttempt',
        targetId: reserved.replay.id,
        afterState: {
          planKey: plan.key,
          planVersion: plan.version,
          venueCount: venueIds.length,
          amountMinor: agreedAmountMinor.toString(),
          currency: billingCurrency,
          pricingSource: negotiatedTerms ? 'NEGOTIATED' : 'CATALOG',
          negotiatedReference: negotiatedTerms?.reference ?? null,
          negotiatedReason: negotiatedTerms?.reason ?? null,
          stripeMode: environment.STRIPE_MODE,
          replacedManualAgreementId: reserved.replacementId,
        },
      },
      tx,
    )
  })
  await publishOperationalEvent({
    event: {
      tenantId: params.tenantId,
      eventType: 'billing.checkout-awaiting-completion',
      sourceSubsystem: 'billing',
      severity: 'INFO',
      title: 'Subscription Checkout awaiting completion',
      summary: 'A hosted test-mode Checkout session is awaiting verified Stripe events.',
      actionRequired: false,
      linkedObjectType: 'BillingCheckoutAttempt',
      linkedObjectId: reserved.replay.id,
      deduplicationKey: `billing-checkout:${reserved.replay.id}`,
    },
  })
  return { attemptId: reserved.replay.id, sessionId: session.id, url: session.url, replayed: false }
}

export async function createTenantPortal(params: {
  tenantId: string
  provider: BillingProvider
  environment?: BillingEnvironment
  client?: DbClient
}) {
  const client = params.client ?? db
  const environment = params.environment ?? parseBillingEnvironment()
  if (
    !billingCapabilityEnabled('portal', environment) ||
    !environment.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID
  ) {
    throw new BillingServiceError('DISABLED', 'Customer Portal is disabled.')
  }
  const account = await client.billingAccount.findUnique({
    where: { tenantId: params.tenantId },
    include: {
      commercialAgreements: { where: { tenantId: params.tenantId, isBase: true }, take: 1 },
    },
  })
  if (!account?.stripeCustomerId)
    throw new BillingServiceError('NOT_FOUND', 'No Stripe customer is linked.')
  const policy = customerPortalPolicy({
    minimumCommitmentEndsAt: account.commercialAgreements[0]?.minimumCommitmentEndsAt ?? null,
    planChangesEnabled: false,
  })
  if (policy.minimumTermActive) {
    throw new BillingServiceError(
      'UNSAFE_PORTAL_POLICY',
      'Contact Torchiko to manage billing during the minimum commitment.',
    )
  }
  return params.provider.createPortalSession({
    customerId: account.stripeCustomerId,
    returnUrl: `${new URL(environment.DASHBOARD_URL).origin}/payment`,
    configurationId: environment.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID,
  })
}

function projectedStatus(status: ReturnType<typeof projectStripeSubscription>['status']) {
  return status === 'INCOMPLETE' ? 'PENDING' : status === 'INCOMPLETE_EXPIRED' ? 'ENDED' : status
}

function projectedAccountStatus(status: ReturnType<typeof projectStripeSubscription>['status']) {
  const projected = projectedStatus(status)
  return projected === 'TRIALING' ? 'MANUAL_REVIEW' : projected
}

async function quarantine(params: {
  receiptId: string
  eventId: string
  reason: string
  client: DbClient
}) {
  await params.client.stripeWebhookReceipt.update({
    where: { id: params.receiptId },
    data: {
      processingStatus: 'QUARANTINED',
      quarantineReason: params.reason,
      processedAt: new Date(),
    },
  })
  await publishPlatformOperationalEvent({
    event: {
      eventType: 'billing.unknown-stripe-object',
      sourceSubsystem: 'billing',
      severity: 'ERROR',
      title: 'Unknown Stripe billing object',
      summary: params.reason,
      actionRequired: true,
      linkedObjectType: 'StripeWebhookReceipt',
      linkedObjectId: params.receiptId,
      recommendedAction: 'Verify tenant metadata and provider mappings, then run reconciliation.',
      deduplicationKey: `stripe-unknown:${params.eventId}`,
    },
  })
  return { status: 'quarantined' as const, receiptId: params.receiptId }
}

export async function applyVerifiedStripeEvent(params: {
  event: Stripe.Event
  rawPayload: string
  client?: DbClient
  environment?: BillingEnvironment
  provider?: BillingProvider
}) {
  const client = params.client ?? db
  const environment = params.environment ?? parseBillingEnvironment()
  if (!billingCapabilityEnabled('webhook', environment)) {
    throw new BillingServiceError('DISABLED', 'Webhook processing is disabled.')
  }
  if (params.event.livemode !== (environment.STRIPE_MODE === 'live')) {
    throw new BillingServiceError(
      'INVALID_PROVIDER_EVENT',
      'Stripe event mode does not match server configuration.',
    )
  }
  const stripeMode = mode(environment)
  const refs = normalizedStripeObjectReference(params.event)
  const payloadHash = createHash('sha256').update(params.rawPayload, 'utf8').digest('hex')
  const identity = {
    stripeMode,
    stripeAccountId: environment.STRIPE_ACCOUNT_NAMESPACE,
    stripeEventId: params.event.id,
  }
  const existing = await client.stripeWebhookReceipt.findUnique({
    where: { stripeMode_stripeAccountId_stripeEventId: identity },
  })
  let receipt = existing
  if (receipt) {
    if (receipt.payloadHash !== payloadHash) {
      throw new BillingServiceError(
        'INVALID_PROVIDER_EVENT',
        'Stored Stripe event identity has a different payload hash.',
      )
    }
    if (['APPLIED', 'IGNORED', 'QUARANTINED'].includes(receipt.processingStatus)) {
      return { status: 'duplicate' as const, receiptId: receipt.id }
    }
    if (
      receipt.processingStatus === 'PROCESSING' &&
      receipt.lastAttemptAt &&
      receipt.lastAttemptAt > new Date(Date.now() - 5 * 60_000)
    ) {
      return { status: 'duplicate' as const, receiptId: receipt.id }
    }
  }
  receipt ??= await client.stripeWebhookReceipt.create({
    data: {
      ...identity,
      eventType: params.event.type,
      apiVersion: params.event.api_version ?? null,
      primaryObjectId: refs.objectId,
      stripeCustomerId: refs.customerId,
      stripeSubscriptionId: refs.subscriptionId,
      stripeInvoiceId: refs.invoiceId,
      providerCreatedAt: new Date(params.event.created * 1000),
      payloadHash,
      sanitizedObject: sanitizedStripeEventSummary(params.event),
    },
  })
  if (!isSupportedStripeEventType(params.event.type)) {
    await client.stripeWebhookReceipt.update({
      where: { id: receipt.id },
      data: { processingStatus: 'IGNORED', processedAt: new Date() },
    })
    return { status: 'ignored' as const, receiptId: receipt.id }
  }
  if (
    !refs.customerId &&
    params.provider &&
    (params.event.type === 'charge.dispute.created' || params.event.type.startsWith('refund.'))
  ) {
    const providerObject = params.event.data.object as unknown as Record<string, unknown>
    const chargeId =
      typeof providerObject.charge === 'string'
        ? providerObject.charge
        : providerObject.charge &&
            typeof providerObject.charge === 'object' &&
            'id' in providerObject.charge
          ? String((providerObject.charge as { id: unknown }).id)
          : null
    if (chargeId) {
      const charge = await params.provider.retrieveCharge(chargeId)
      refs.customerId =
        typeof charge.customer === 'string' ? charge.customer : (charge.customer?.id ?? null)
      await client.stripeWebhookReceipt.update({
        where: { id: receipt.id },
        data: { stripeCustomerId: refs.customerId },
      })
    }
  }
  try {
    return await withTenantIsolationBypass(async () => {
      await client.stripeWebhookReceipt.update({
        where: { id: receipt.id },
        data: {
          processingStatus: 'PROCESSING',
          attemptCount: { increment: 1 },
          lastAttemptAt: new Date(),
        },
      })
      const object = params.event.data.object as unknown as Record<string, unknown>
      const metadata =
        object.metadata && typeof object.metadata === 'object'
          ? (object.metadata as Record<string, unknown>)
          : {}
      const metadataTenantId =
        typeof metadata.torchiko_tenant_id === 'string' ? metadata.torchiko_tenant_id : null
      const metadataAgreementId =
        typeof metadata.torchiko_agreement_id === 'string' ? metadata.torchiko_agreement_id : null
      const account = refs.customerId
        ? await client.billingAccount.findFirst({
            where: {
              stripeMode,
              stripeAccountId: environment.STRIPE_ACCOUNT_NAMESPACE,
              stripeCustomerId: refs.customerId,
            },
          })
        : null
      const agreement = refs.subscriptionId
        ? await client.commercialAgreement.findFirst({
            where: {
              stripeMode,
              stripeAccountId: environment.STRIPE_ACCOUNT_NAMESPACE,
              stripeSubscriptionId: refs.subscriptionId,
            },
          })
        : metadataAgreementId
          ? await client.commercialAgreement.findFirst({
              where: {
                id: metadataAgreementId,
                ...(metadataTenantId ? { tenantId: metadataTenantId } : {}),
              },
            })
          : null
      const resolvedAccount =
        account ??
        (agreement
          ? await client.billingAccount.findFirst({
              where: { id: agreement.billingAccountId, tenantId: agreement.tenantId },
            })
          : null)
      if (!resolvedAccount || (metadataTenantId && metadataTenantId !== resolvedAccount.tenantId)) {
        return quarantine({
          receiptId: receipt.id,
          eventId: params.event.id,
          reason: 'No unique tenant-owned billing account matched the verified Stripe object.',
          client,
        })
      }
      const providerCreatedAt = new Date(params.event.created * 1000)
      let applicationStatus: 'APPLIED' | 'IGNORED_STALE' = 'APPLIED'
      let appliedObjectType = 'BillingAccount'
      let appliedObjectId = resolvedAccount.id
      let transition: Record<string, unknown> = { eventType: params.event.type }
      await client.$transaction(async (tx) => {
        if (params.event.type.startsWith('checkout.session.')) {
          const operationKey =
            typeof metadata.torchiko_operation_id === 'string'
              ? metadata.torchiko_operation_id
              : null
          const attempt = refs.objectId
            ? await tx.billingCheckoutAttempt.findFirst({
                where: {
                  tenantId: resolvedAccount.tenantId,
                  stripeCheckoutSessionId: refs.objectId,
                },
              })
            : operationKey
              ? await tx.billingCheckoutAttempt.findFirst({
                  where: { tenantId: resolvedAccount.tenantId, operationKey },
                })
              : null
          if (!attempt)
            throw new BillingServiceError('NOT_FOUND', 'Checkout attempt mapping is missing.')
          const completed =
            params.event.type === 'checkout.session.completed' ||
            params.event.type === 'checkout.session.async_payment_succeeded'
          const expired = params.event.type === 'checkout.session.expired'
          await tx.billingCheckoutAttempt.update({
            where: { id: attempt.id, tenantId: attempt.tenantId },
            data: {
              status: completed ? 'COMPLETED' : expired ? 'EXPIRED' : 'FAILED',
              completedAt: completed ? new Date() : null,
              failureCode:
                params.event.type === 'checkout.session.async_payment_failed'
                  ? 'ASYNC_PAYMENT_FAILED'
                  : null,
              providerStateChangedAt: providerCreatedAt,
              lastAppliedStripeEventId: params.event.id,
              lastAppliedStripeEventAt: providerCreatedAt,
            },
          })
          appliedObjectType = 'BillingCheckoutAttempt'
          appliedObjectId = attempt.id
          transition = {
            ...transition,
            checkoutStatus: completed
              ? 'COMPLETED_PENDING_SUBSCRIPTION_WEBHOOK'
              : expired
                ? 'EXPIRED'
                : 'FAILED',
          }
        } else if (params.event.type.startsWith('customer.subscription.')) {
          const projection = projectStripeSubscription(
            params.event.data.object as Stripe.Subscription,
          )
          const target =
            agreement ??
            (projection.agreementMetadata
              ? await tx.commercialAgreement.findFirst({
                  where: { id: projection.agreementMetadata, tenantId: resolvedAccount.tenantId },
                })
              : null)
          if (
            !target ||
            projection.stripeCustomerId !== resolvedAccount.stripeCustomerId ||
            (projection.tenantMetadata && projection.tenantMetadata !== resolvedAccount.tenantId)
          ) {
            throw new BillingServiceError(
              'FORBIDDEN',
              'Subscription ownership does not match the billing account.',
            )
          }
          if (
            !isNewerProviderState({
              incomingAt: providerCreatedAt,
              incomingEventId: params.event.id,
              appliedAt: target.lastAppliedStripeEventAt,
              appliedEventId: target.lastAppliedStripeEventId,
            })
          ) {
            applicationStatus = 'IGNORED_STALE'
          } else {
            const graceEndsAt =
              projection.status === 'PAST_DUE'
                ? new Date(
                    providerCreatedAt.getTime() +
                      environment.BILLING_GRACE_PERIOD_DAYS * 86_400_000,
                  )
                : null
            await tx.commercialAgreement.update({
              where: { id: target.id, tenantId: target.tenantId },
              data: {
                status: projectedStatus(projection.status),
                stripeSubscriptionId: projection.stripeSubscriptionId,
                stripeSubscriptionStatus: projection.status,
                stripePriceId: projection.stripePriceId,
                stripeProductId: projection.stripeProductId,
                quantity: Math.max(1, projection.quantity),
                currentPeriodStartsAt: projection.currentPeriodStartsAt,
                currentPeriodEndsAt: projection.currentPeriodEndsAt,
                trialStartsAt: projection.trialStartsAt,
                trialEndsAt: projection.trialEndsAt,
                cancelAtPeriodEnd: projection.cancelAtPeriodEnd,
                cancellationEffectiveAt: projection.cancellationEffectiveAt,
                endedAt: projection.endedAt,
                providerStateChangedAt: providerCreatedAt,
                lastAppliedStripeEventId: params.event.id,
                lastAppliedStripeEventAt: providerCreatedAt,
                updatedBy: 'stripe-webhook',
              },
            })
            await tx.billingAccount.update({
              where: { id: resolvedAccount.id, tenantId: resolvedAccount.tenantId },
              data: {
                status: projectedAccountStatus(projection.status),
                gracePeriodEndsAt: graceEndsAt,
                paidThroughAt: projection.currentPeriodEndsAt,
                providerStateChangedAt: providerCreatedAt,
                lastAppliedStripeEventId: params.event.id,
                lastAppliedStripeEventAt: providerCreatedAt,
                updatedBy: 'stripe-webhook',
              },
            })
            transition = {
              ...transition,
              subscriptionStatus: projection.status,
              gracePeriodEndsAt: graceEndsAt?.toISOString() ?? null,
            }
          }
          appliedObjectType = 'CommercialAgreement'
          appliedObjectId = target.id
        } else if (params.event.type.startsWith('invoice.')) {
          if (!agreement)
            throw new BillingServiceError('NOT_FOUND', 'Invoice subscription mapping is missing.')
          const projection = projectStripeInvoice({
            invoice: params.event.data.object as Stripe.Invoice,
            eventType: params.event.type,
            providerCreatedAt,
          })
          const current = await tx.billingInvoiceProjection.findFirst({
            where: {
              tenantId: agreement.tenantId,
              stripeMode,
              stripeAccountId: environment.STRIPE_ACCOUNT_NAMESPACE,
              stripeInvoiceId: projection.stripeInvoiceId,
            },
          })
          if (
            current &&
            !isNewerProviderState({
              incomingAt: providerCreatedAt,
              incomingEventId: params.event.id,
              appliedAt: current.lastAppliedStripeEventAt,
              appliedEventId: current.lastAppliedStripeEventId,
            })
          ) {
            applicationStatus = 'IGNORED_STALE'
            appliedObjectType = 'BillingInvoiceProjection'
            appliedObjectId = current.id
          } else {
            const data = {
              source: 'STRIPE' as const,
              status: projection.status,
              invoiceNumber: projection.invoiceNumber,
              amountDueMinor: projection.amountDueMinor,
              amountPaidMinor: projection.amountPaidMinor,
              amountRemainingMinor: projection.amountRemainingMinor,
              currency: projection.currency,
              hostedInvoiceUrl: projection.hostedInvoiceUrl,
              invoiceDocumentUrl: projection.invoiceDocumentUrl,
              dueAt: projection.dueAt,
              paidAt: projection.paidAt,
              failedAt: projection.failedAt,
              voidedAt: projection.voidedAt,
              nextRetryAt: projection.nextRetryAt,
              failureCode: projection.failureCode,
              failureSummary: projection.failureSummary,
              providerStateChangedAt: providerCreatedAt,
              lastAppliedStripeEventId: params.event.id,
              lastAppliedStripeEventAt: providerCreatedAt,
            }
            const saved = current
              ? await tx.billingInvoiceProjection.update({
                  where: { id: current.id, tenantId: current.tenantId },
                  data,
                })
              : await tx.billingInvoiceProjection.create({
                  data: {
                    tenantId: agreement.tenantId,
                    billingAccountId: resolvedAccount.id,
                    commercialAgreementId: agreement.id,
                    stripeMode,
                    stripeAccountId: environment.STRIPE_ACCOUNT_NAMESPACE,
                    stripeInvoiceId: projection.stripeInvoiceId,
                    ...data,
                  },
                })
            appliedObjectType = 'BillingInvoiceProjection'
            appliedObjectId = saved.id
            transition = {
              ...transition,
              invoiceStatus: projection.status,
              paymentFailure: projection.failureCode,
            }
            if (
              (params.event.type === 'invoice.payment_failed' ||
                params.event.type === 'invoice.payment_action_required') &&
              isNewerProviderState({
                incomingAt: providerCreatedAt,
                incomingEventId: params.event.id,
                appliedAt: agreement.lastAppliedStripeEventAt,
                appliedEventId: agreement.lastAppliedStripeEventId,
              })
            ) {
              const graceEndsAt = new Date(
                providerCreatedAt.getTime() + environment.BILLING_GRACE_PERIOD_DAYS * 86_400_000,
              )
              await tx.commercialAgreement.update({
                where: { id: agreement.id, tenantId: agreement.tenantId },
                data: {
                  status: 'PAST_DUE',
                  providerStateChangedAt: providerCreatedAt,
                  lastAppliedStripeEventId: params.event.id,
                  lastAppliedStripeEventAt: providerCreatedAt,
                  updatedBy: 'stripe-webhook',
                },
              })
              await tx.billingAccount.update({
                where: { id: resolvedAccount.id, tenantId: resolvedAccount.tenantId },
                data: {
                  status: 'PAST_DUE',
                  gracePeriodEndsAt: graceEndsAt,
                  providerStateChangedAt: providerCreatedAt,
                  lastAppliedStripeEventId: params.event.id,
                  lastAppliedStripeEventAt: providerCreatedAt,
                  updatedBy: 'stripe-webhook',
                },
              })
              transition = {
                ...transition,
                accessState: 'GRACE_PERIOD',
                gracePeriodEndsAt: graceEndsAt.toISOString(),
              }
            }
          }
        } else if (
          params.event.type === 'charge.dispute.created' ||
          params.event.type.startsWith('refund.')
        ) {
          await tx.billingAccount.update({
            where: { id: resolvedAccount.id, tenantId: resolvedAccount.tenantId },
            data: {
              status: 'MANUAL_REVIEW',
              providerStateChangedAt: providerCreatedAt,
              lastAppliedStripeEventId: params.event.id,
              lastAppliedStripeEventAt: providerCreatedAt,
              updatedBy: 'stripe-webhook',
            },
          })
          transition = { ...transition, status: 'MANUAL_REVIEW' }
        } else {
          applicationStatus = 'IGNORED_STALE'
          transition = { ...transition, ignoredReason: 'No independent projection effect' }
        }
        await tx.billingEventApplication.create({
          data: {
            tenantId: resolvedAccount.tenantId,
            billingAccountId: resolvedAccount.id,
            commercialAgreementId: agreement?.id ?? null,
            stripeReceiptId: receipt.id,
            eventType: params.event.type,
            providerCreatedAt,
            status: applicationStatus,
            appliedObjectType,
            appliedObjectId,
            transition,
          },
        })
        await tx.stripeWebhookReceipt.update({
          where: { id: receipt.id },
          data: {
            resolvedTenantId: resolvedAccount.tenantId,
            processingStatus: applicationStatus === 'APPLIED' ? 'APPLIED' : 'IGNORED',
            processedAt: new Date(),
          },
        })
      })
      if (
        params.event.type === 'invoice.payment_failed' ||
        params.event.type === 'charge.dispute.created' ||
        params.event.type.startsWith('refund.')
      ) {
        await publishOperationalEvent({
          event: {
            tenantId: resolvedAccount.tenantId,
            eventType:
              params.event.type === 'invoice.payment_failed'
                ? 'billing.payment-failed'
                : 'billing.manual-review-required',
            sourceSubsystem: 'billing',
            severity: params.event.type === 'charge.dispute.created' ? 'CRITICAL' : 'WARNING',
            title:
              params.event.type === 'invoice.payment_failed'
                ? 'Subscription payment failed'
                : 'Billing review required',
            summary:
              'A verified Stripe test-mode event requires attention. No venue data was deleted.',
            actionRequired: true,
            linkedObjectType: appliedObjectType,
            linkedObjectId: appliedObjectId,
            recommendedAction: 'Review the billing account and provider dashboard, then reconcile.',
            deduplicationKey: `billing-attention:${params.event.id}`,
          },
        }).catch(() => undefined)
      }
      const subscriptionStatus = transition.subscriptionStatus
      if (
        subscriptionStatus === 'ACTIVE' ||
        subscriptionStatus === 'TRIALING' ||
        subscriptionStatus === 'CANCELED'
      ) {
        await publishOperationalEvent({
          event: {
            tenantId: resolvedAccount.tenantId,
            eventType:
              subscriptionStatus === 'CANCELED'
                ? 'billing.subscription-ended'
                : 'billing.subscription-activated',
            sourceSubsystem: 'billing',
            severity: subscriptionStatus === 'CANCELED' ? 'WARNING' : 'INFO',
            title:
              subscriptionStatus === 'CANCELED' ? 'Subscription ended' : 'Subscription activated',
            summary:
              subscriptionStatus === 'CANCELED'
                ? 'Stripe reports that the subscription has ended; paid-through policy remains authoritative for access.'
                : `Stripe reports the subscription as ${String(subscriptionStatus).toLowerCase()}.`,
            actionRequired: subscriptionStatus === 'CANCELED',
            linkedObjectType: appliedObjectType,
            linkedObjectId: appliedObjectId,
            ...(subscriptionStatus === 'CANCELED'
              ? {
                  recommendedAction:
                    'Confirm paid-through access and customer recovery or offboarding steps.',
                }
              : {}),
            deduplicationKey: `billing-subscription:${appliedObjectId}:${String(subscriptionStatus).toLowerCase()}`,
          },
        }).catch(() => undefined)
      }
      return {
        status: applicationStatus === 'APPLIED' ? ('applied' as const) : ('stale' as const),
        receiptId: receipt.id,
      }
    })
  } catch (error) {
    await client.stripeWebhookReceipt
      .update({
        where: { id: receipt.id },
        data: {
          processingStatus: 'FAILED',
          errorCode: error instanceof BillingServiceError ? error.code : 'PROCESSING_FAILED',
          lastAttemptAt: new Date(),
        },
      })
      .catch(() => undefined)
    await publishPlatformOperationalEvent({
      event: {
        eventType: 'billing.webhook-processing-failure',
        sourceSubsystem: 'billing',
        severity: 'ERROR',
        title: 'Stripe webhook processing failed',
        summary: `Verified Stripe event ${params.event.id} could not be applied and remains retryable.`,
        actionRequired: true,
        linkedObjectType: 'StripeWebhookReceipt',
        linkedObjectId: receipt.id,
        recommendedAction:
          'Inspect sanitized service logs, repair configuration or mappings, and allow Stripe to retry.',
        deduplicationKey: `stripe-webhook-failure:${params.event.id}`,
      },
    }).catch(() => undefined)
    throw error
  }
}

export async function reconcileBillingAccount(params: {
  tenantId: string
  actorId: string
  trigger: 'SCHEDULED' | 'ON_DEMAND' | 'WEBHOOK_RECOVERY'
  provider: BillingProvider
  environment?: BillingEnvironment
  client?: DbClient
}) {
  const client = params.client ?? db
  const environment = params.environment ?? parseBillingEnvironment()
  if (!billingCapabilityEnabled('reconciliation', environment)) {
    throw new BillingServiceError('DISABLED', 'Billing reconciliation is disabled.')
  }
  const account = await client.billingAccount.findUnique({
    where: { tenantId: params.tenantId },
    include: {
      commercialAgreements: {
        where: { tenantId: params.tenantId, stripeSubscriptionId: { not: null } },
      },
      invoiceProjections: {
        where: { tenantId: params.tenantId, source: 'STRIPE', stripeInvoiceId: { not: null } },
      },
    },
  })
  if (!account) throw new BillingServiceError('NOT_FOUND', 'Billing account not found.')
  const run = await client.billingReconciliationRun.create({
    data: {
      tenantId: params.tenantId,
      billingAccountId: account.id,
      trigger: params.trigger,
      initiatedBy: params.actorId,
    },
  })
  try {
    let repaired = 0
    for (const agreement of account.commercialAgreements) {
      if (!agreement.stripeSubscriptionId) continue
      const projection = projectStripeSubscription(
        await params.provider.retrieveSubscription(agreement.stripeSubscriptionId),
      )
      if (
        projection.stripeCustomerId !== account.stripeCustomerId ||
        (projection.tenantMetadata && projection.tenantMetadata !== params.tenantId)
      ) {
        throw new BillingServiceError('FORBIDDEN', 'Reconciliation provider ownership mismatch.')
      }
      const changed =
        projection.status !== agreement.stripeSubscriptionStatus ||
        projection.currentPeriodEndsAt?.getTime() !== agreement.currentPeriodEndsAt?.getTime()
      if (changed) {
        repaired += 1
        await client.commercialAgreement.update({
          where: { id: agreement.id, tenantId: params.tenantId },
          data: {
            status: projectedStatus(projection.status),
            stripeSubscriptionStatus: projection.status,
            currentPeriodStartsAt: projection.currentPeriodStartsAt,
            currentPeriodEndsAt: projection.currentPeriodEndsAt,
            cancelAtPeriodEnd: projection.cancelAtPeriodEnd,
            cancellationEffectiveAt: projection.cancellationEffectiveAt,
            endedAt: projection.endedAt,
            providerStateChangedAt: new Date(),
            updatedBy: params.actorId,
          },
        })
      }
    }
    for (const invoice of account.invoiceProjections) {
      if (!invoice.stripeInvoiceId) continue
      const projection = projectStripeInvoice({
        invoice: await params.provider.retrieveInvoice(invoice.stripeInvoiceId),
        eventType: invoice.status === 'PAID' ? 'invoice.paid' : 'invoice.updated',
        providerCreatedAt: new Date(),
      })
      const agreement = account.commercialAgreements.find(
        (candidate) => candidate.id === invoice.commercialAgreementId,
      )
      if (
        projection.stripeCustomerId !== account.stripeCustomerId ||
        !agreement ||
        (projection.stripeSubscriptionId &&
          projection.stripeSubscriptionId !== agreement.stripeSubscriptionId)
      ) {
        throw new BillingServiceError('FORBIDDEN', 'Reconciliation invoice ownership mismatch.')
      }
      const changed =
        projection.status !== invoice.status ||
        projection.amountPaidMinor !== invoice.amountPaidMinor ||
        projection.amountRemainingMinor !== invoice.amountRemainingMinor
      if (changed) {
        repaired += 1
        await client.billingInvoiceProjection.update({
          where: { id: invoice.id, tenantId: params.tenantId },
          data: {
            status: projection.status,
            invoiceNumber: projection.invoiceNumber,
            amountDueMinor: projection.amountDueMinor,
            amountPaidMinor: projection.amountPaidMinor,
            amountRemainingMinor: projection.amountRemainingMinor,
            hostedInvoiceUrl: projection.hostedInvoiceUrl,
            invoiceDocumentUrl: projection.invoiceDocumentUrl,
            dueAt: projection.dueAt,
            paidAt: projection.paidAt,
            failedAt: projection.failedAt,
            voidedAt: projection.voidedAt,
            nextRetryAt: projection.nextRetryAt,
            failureCode: projection.failureCode,
            failureSummary: projection.failureSummary,
            providerStateChangedAt: new Date(),
          },
        })
      }
    }
    const comparedObjectCount =
      account.commercialAgreements.length + account.invoiceProjections.length
    await client.$transaction(async (tx) => {
      await tx.billingReconciliationRun.update({
        where: { id: run.id, tenantId: params.tenantId },
        data: {
          status: repaired ? 'DRIFT_DETECTED' : 'SUCCEEDED',
          completedAt: new Date(),
          comparedObjectCount,
          repairedObjectCount: repaired,
          driftSummary: repaired ? { repairedSubscriptions: repaired } : {},
        },
      })
      await tx.billingAccount.update({
        where: { id: account.id, tenantId: params.tenantId },
        data: {
          reconciliationHealth: repaired ? 'DRIFT' : 'CURRENT',
          lastReconciledAt: new Date(),
          lastReconciliationError: null,
          updatedBy: params.actorId,
        },
      })
      if (params.trigger === 'ON_DEMAND') {
        await writeAuditLogStrict(
          {
            tenantId: params.tenantId,
            actorId: params.actorId,
            actorRole: 'PLATFORM_ADMIN',
            action: 'billing.reconciliation.completed',
            targetType: 'BillingReconciliationRun',
            targetId: run.id,
            afterState: {
              comparedObjectCount,
              repairedObjectCount: repaired,
            },
          },
          tx,
        )
      }
    })
    if (repaired) {
      await publishOperationalEvent({
        event: {
          tenantId: params.tenantId,
          eventType: 'billing.reconciliation-drift',
          sourceSubsystem: 'billing',
          severity: 'WARNING',
          title: 'Billing reconciliation repaired drift',
          summary: `${repaired} subscription projection(s) were repaired from Stripe.`,
          actionRequired: true,
          linkedObjectType: 'BillingReconciliationRun',
          linkedObjectId: run.id,
          recommendedAction: 'Review repaired fields and recent webhook delivery health.',
          deduplicationKey: `billing-reconciliation:${run.id}`,
        },
      })
    }
    return { runId: run.id, compared: comparedObjectCount, repaired }
  } catch (error) {
    await client.billingReconciliationRun.update({
      where: { id: run.id, tenantId: params.tenantId },
      data: { status: 'FAILED', completedAt: new Date(), errorCode: 'RECONCILIATION_FAILED' },
    })
    await client.billingAccount.update({
      where: { id: account.id, tenantId: params.tenantId },
      data: {
        reconciliationHealth: 'ERROR',
        lastReconciliationError: 'Reconciliation failed; inspect sanitized service logs.',
        updatedBy: params.actorId,
      },
    })
    throw error
  }
}

export async function createManualBillingArrangement(params: {
  tenantId: string
  actorId: string
  mode: 'MANUAL_INVOICE' | 'COMPLIMENTARY' | 'PILOT' | 'NO_BILLING_REQUIRED'
  planKey: string
  amountMinor?: bigint | null
  venueAmounts?: VenuePriceComponent[]
  accessEndsAt?: Date | null
  venueIds: string[]
  reason: string
  reference?: string | null
  client?: DbClient
}) {
  const client = params.client ?? db
  if ((params.mode === 'COMPLIMENTARY' || params.mode === 'PILOT') && !params.accessEndsAt) {
    throw new BillingServiceError(
      'CONFLICT',
      'Complimentary and pilot access require an expiration.',
    )
  }
  const uniqueVenueIds = [...new Set(params.venueIds)]
  const venuePriceBreakdown = normalizeVenuePriceBreakdown({
    venueIds: uniqueVenueIds,
    totalAmountMinor: params.amountMinor ?? null,
    ...(params.venueAmounts ? { venueAmounts: params.venueAmounts } : {}),
  })
  return withTenantIsolationBypass(() =>
    client.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: params.tenantId },
        select: { id: true, name: true },
      })
      if (!tenant) throw new BillingServiceError('NOT_FOUND', 'Tenant not found.')
      const venues = await tx.venue.findMany({
        where: { tenantId: params.tenantId, id: { in: uniqueVenueIds } },
        select: { id: true },
      })
      if (!uniqueVenueIds.length || venues.length !== uniqueVenueIds.length) {
        throw new BillingServiceError('FORBIDDEN', 'Covered venues must belong to the tenant.')
      }
      const current = await tx.commercialAgreement.findFirst({
        where: {
          tenantId: params.tenantId,
          isBase: true,
          status: { in: ['PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED'] },
        },
        select: { id: true },
      })
      if (current)
        throw new BillingServiceError('CONFLICT', 'A current base arrangement already exists.')
      const account = await tx.billingAccount.upsert({
        where: { tenantId: params.tenantId },
        create: {
          tenantId: params.tenantId,
          displayNameSnapshot: tenant.name,
          billingMode: params.mode,
          status: 'ACTIVE',
          createdBy: params.actorId,
          updatedBy: params.actorId,
          internalReference: params.reference ?? null,
        },
        update: {
          billingMode: params.mode,
          status: 'ACTIVE',
          updatedBy: params.actorId,
          internalReference: params.reference ?? null,
        },
      })
      const agreement = await tx.commercialAgreement.create({
        data: {
          tenantId: params.tenantId,
          billingAccountId: account.id,
          isBase: true,
          internalPlanKey: params.planKey,
          status: 'ACTIVE',
          billingMode: params.mode,
          billingInterval: 'CUSTOM',
          quantity: uniqueVenueIds.length,
          coveredVenueCount: uniqueVenueIds.length,
          agreedAmountMinor: params.amountMinor ?? null,
          venuePriceBreakdownComplete: venuePriceBreakdown.length > 0,
          startsAt: new Date(),
          accessStartsAt: new Date(),
          accessEndsAt: params.accessEndsAt ?? null,
          commercialReference: params.reference ?? null,
          createdBy: params.actorId,
          updatedBy: params.actorId,
          coveredVenues: {
            create: uniqueVenueIds.map((venueId) => ({
              venueId,
              agreedAmountMinor:
                venuePriceBreakdown.find((component) => component.venueId === venueId)
                  ?.amountMinor ?? null,
              createdBy: params.actorId,
            })),
          },
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: params.tenantId,
          actorId: params.actorId,
          actorRole: 'PLATFORM_ADMIN',
          action: 'billing.manual-arrangement.created',
          targetType: 'CommercialAgreement',
          targetId: agreement.id,
          afterState: {
            mode: params.mode,
            planKey: params.planKey,
            amountMinor: params.amountMinor?.toString() ?? null,
            venueAmounts: venuePriceBreakdown.map((component) => ({
              venueId: component.venueId,
              amountMinor: component.amountMinor.toString(),
            })),
            accessEndsAt: params.accessEndsAt?.toISOString() ?? null,
            reason: params.reason,
            reference: params.reference ?? null,
          },
        },
        tx,
      )
      return agreement
    }),
  )
}

export async function createBillingAccessOverride(params: {
  tenantId: string
  actorId: string
  agreementId?: string | null
  venueId?: string | null
  effect: 'GRANT' | 'DENY'
  kind: 'MANUAL_PAYMENT' | 'COMPLIMENTARY' | 'PILOT' | 'GRACE_PERIOD' | 'PLATFORM_ADMIN'
  startsAt?: Date
  expiresAt: Date
  reason: string
  reference?: string | null
  client?: DbClient
}) {
  const client = params.client ?? db
  const startsAt = params.startsAt ?? new Date()
  if (params.expiresAt <= startsAt)
    throw new BillingServiceError('CONFLICT', 'Override expiry must follow its start.')
  return withTenantIsolationBypass(() =>
    client.$transaction(async (tx) => {
      const account = await tx.billingAccount.findUnique({ where: { tenantId: params.tenantId } })
      if (!account) throw new BillingServiceError('NOT_FOUND', 'Billing account not found.')
      if (params.agreementId) {
        const agreement = await tx.commercialAgreement.findFirst({
          where: {
            id: params.agreementId,
            tenantId: params.tenantId,
            billingAccountId: account.id,
          },
        })
        if (!agreement)
          throw new BillingServiceError(
            'FORBIDDEN',
            'Agreement does not belong to this billing account.',
          )
      }
      if (params.venueId) {
        const venue = await tx.venue.findFirst({
          where: { id: params.venueId, tenantId: params.tenantId },
        })
        if (!venue)
          throw new BillingServiceError('FORBIDDEN', 'Venue does not belong to this tenant.')
      }
      const override = await tx.billingAccessOverride.create({
        data: {
          tenantId: params.tenantId,
          billingAccountId: account.id,
          commercialAgreementId: params.agreementId ?? null,
          venueId: params.venueId ?? null,
          effect: params.effect,
          kind: params.kind,
          startsAt,
          expiresAt: params.expiresAt,
          reason: params.reason,
          sourceReference: params.reference ?? null,
          createdBy: params.actorId,
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: params.tenantId,
          actorId: params.actorId,
          actorRole: 'PLATFORM_ADMIN',
          action: 'billing.access-override.created',
          targetType: 'BillingAccessOverride',
          targetId: override.id,
          afterState: {
            agreementId: params.agreementId ?? null,
            venueId: params.venueId ?? null,
            effect: params.effect,
            kind: params.kind,
            startsAt: startsAt.toISOString(),
            expiresAt: params.expiresAt.toISOString(),
            reason: params.reason,
            reference: params.reference ?? null,
          },
        },
        tx,
      )
      return override
    }),
  )
}

export async function recordManualPayment(params: {
  tenantId: string
  agreementId: string
  actorId: string
  amountMinor: bigint
  currency: string
  paidAt: Date
  paidThroughAt?: Date | null
  reference: string
  reason: string
  client?: DbClient
}) {
  const client = params.client ?? db
  return withTenantIsolationBypass(() =>
    client.$transaction(async (tx) => {
      const agreement = await tx.commercialAgreement.findFirst({
        where: { id: params.agreementId, tenantId: params.tenantId },
      })
      if (
        !agreement ||
        agreement.billingMode === 'STRIPE_SUBSCRIPTION' ||
        agreement.billingMode === 'STRIPE_INVOICE'
      ) {
        throw new BillingServiceError(
          'FORBIDDEN',
          'Manual payment evidence can only apply to a manual commercial arrangement.',
        )
      }
      const invoice = await tx.billingInvoiceProjection.create({
        data: {
          tenantId: params.tenantId,
          billingAccountId: agreement.billingAccountId,
          commercialAgreementId: agreement.id,
          source: 'MANUAL',
          invoiceNumber: params.reference,
          status: 'PAID',
          amountDueMinor: params.amountMinor,
          amountPaidMinor: params.amountMinor,
          amountRemainingMinor: 0n,
          currency: params.currency.toLowerCase(),
          paidAt: params.paidAt,
        },
      })
      await tx.commercialAgreement.update({
        where: { id: agreement.id, tenantId: params.tenantId },
        data: { status: 'ACTIVE', updatedBy: params.actorId },
      })
      await tx.billingAccount.update({
        where: { id: agreement.billingAccountId, tenantId: params.tenantId },
        data: {
          status: 'ACTIVE',
          paidThroughAt: params.paidThroughAt ?? null,
          updatedBy: params.actorId,
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: params.tenantId,
          actorId: params.actorId,
          actorRole: 'PLATFORM_ADMIN',
          action: 'billing.manual-payment.recorded',
          targetType: 'BillingInvoiceProjection',
          targetId: invoice.id,
          afterState: {
            agreementId: agreement.id,
            amountMinor: params.amountMinor.toString(),
            currency: params.currency.toLowerCase(),
            paidAt: params.paidAt.toISOString(),
            paidThroughAt: params.paidThroughAt?.toISOString() ?? null,
            reference: params.reference,
            reason: params.reason,
            source: 'MANUAL',
          },
        },
        tx,
      )
      return invoice
    }),
  )
}
