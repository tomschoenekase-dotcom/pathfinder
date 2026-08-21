import { db, publishOperationalEvent, writeAuditLogStrict } from '@pathfinder/db'

import {
  billingCapabilityEnabled,
  parseBillingEnvironment,
  type BillingEnvironment,
} from './config'
import type { BillingProvider } from './provider'
import { BillingServiceError } from './service'

type DbClient = typeof db

export const BILLING_ADD_ON_CATALOG = [
  {
    key: 'premium-voice',
    label: 'Premium voice mode',
    description: 'Let visitors speak naturally with your Torchiko guide.',
  },
  {
    key: 'custom-branding',
    label: 'Custom branding and personality',
    description: 'A more distinctive visual identity, voice, and guide personality.',
  },
  {
    key: 'advanced-reporting',
    label: 'Advanced reporting',
    description: 'Deeper visitor-interest, content-gap, and engagement reporting.',
  },
  {
    key: 'multi-venue-expansion',
    label: 'Additional venue coverage',
    description: 'Bring another property or location into the same Torchiko account.',
  },
] as const

export async function requestTenantCancellation(params: {
  tenantId: string
  actorId: string
  actorRole: string
  operationId: string
  reason: string
  provider: BillingProvider
  environment?: BillingEnvironment
  client?: DbClient
}) {
  const client = params.client ?? db
  const environment = params.environment ?? parseBillingEnvironment()
  if (!billingCapabilityEnabled('cancellation', environment)) {
    throw new BillingServiceError('DISABLED', 'Subscription cancellation is disabled.')
  }
  const reserved = await client.$transaction(async (tx) => {
    const replay = await tx.billingCustomerRequest.findFirst({
      where: { tenantId: params.tenantId, operationId: params.operationId },
    })
    if (replay) return { request: replay, agreement: null, replayed: true }
    const account = await tx.billingAccount.findUnique({
      where: { tenantId: params.tenantId },
      include: {
        commercialAgreements: {
          where: { tenantId: params.tenantId, isBase: true },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
    })
    const agreement = account?.commercialAgreements[0]
    if (!account || !agreement?.stripeSubscriptionId) {
      throw new BillingServiceError('NOT_FOUND', 'No active Stripe subscription is linked.')
    }
    if (agreement.minimumCommitmentEndsAt && agreement.minimumCommitmentEndsAt > new Date()) {
      throw new BillingServiceError(
        'UNSAFE_PORTAL_POLICY',
        'Contact Torchiko to cancel during the minimum commitment.',
      )
    }
    if (agreement.cancelAtPeriodEnd || ['CANCELED', 'ENDED'].includes(agreement.status)) {
      throw new BillingServiceError('CONFLICT', 'This subscription is already ending.')
    }
    const existing = await tx.billingCustomerRequest.findFirst({
      where: {
        tenantId: params.tenantId,
        kind: 'CANCELLATION',
        status: { in: ['OPEN', 'PROCESSING', 'COMPLETED'] },
        commercialAgreementId: agreement.id,
      },
    })
    if (existing) throw new BillingServiceError('CONFLICT', 'A cancellation is already recorded.')
    const request = await tx.billingCustomerRequest.create({
      data: {
        operationId: params.operationId,
        tenantId: params.tenantId,
        billingAccountId: account.id,
        commercialAgreementId: agreement.id,
        kind: 'CANCELLATION',
        status: 'PROCESSING',
        requestedBy: params.actorId,
        reason: params.reason,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: params.tenantId,
        actorId: params.actorId,
        actorRole: params.actorRole,
        action: 'billing.cancellation.requested',
        targetType: 'BillingCustomerRequest',
        targetId: request.id,
        afterState: {
          agreementId: agreement.id,
          reason: params.reason,
          providerAction: 'cancel_at_period_end',
        },
      },
      tx,
    )
    return { request, agreement, replayed: false }
  })
  if (reserved.replayed || !reserved.agreement) {
    return { request: reserved.request, replayed: true, awaitingWebhook: true }
  }
  try {
    await params.provider.cancelSubscriptionAtPeriodEnd({
      subscriptionId: reserved.agreement.stripeSubscriptionId!,
      tenantId: params.tenantId,
      requestId: reserved.request.id,
      reason: params.reason,
      operationId: params.operationId,
    })
    const request = await client.$transaction(async (tx) => {
      const completed = await tx.billingCustomerRequest.update({
        where: { id: reserved.request.id, tenantId: params.tenantId },
        data: {
          status: 'COMPLETED',
          providerActionAt: new Date(),
          resolvedAt: new Date(),
          resolvedBy: params.actorId,
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: params.tenantId,
          actorId: params.actorId,
          actorRole: params.actorRole,
          action: 'billing.cancellation.sent-to-provider',
          targetType: 'BillingCustomerRequest',
          targetId: completed.id,
          afterState: { awaitingVerifiedSubscriptionWebhook: true },
        },
        tx,
      )
      return completed
    })
    await publishOperationalEvent({
      event: {
        tenantId: params.tenantId,
        eventType: 'billing.subscription-ending',
        sourceSubsystem: 'billing',
        severity: 'WARNING',
        title: 'Customer requested subscription cancellation',
        summary: 'Stripe was asked to cancel at period end. Access remains through paid-through.',
        actionRequired: true,
        recommendedAction: 'Review the customer reason in Billing and follow up through the CRM.',
        linkedObjectType: 'BillingCustomerRequest',
        linkedObjectId: request.id,
        deduplicationKey: `billing-cancellation:${request.id}`,
      },
    })
    return { request, replayed: false, awaitingWebhook: true }
  } catch (error) {
    await client.billingCustomerRequest.update({
      where: { id: reserved.request.id, tenantId: params.tenantId },
      data: { status: 'FAILED', failureCode: 'PROVIDER_ERROR', resolvedAt: new Date() },
    })
    throw error
  }
}

export async function recordTenantAddOnInterest(params: {
  tenantId: string
  actorId: string
  actorRole: string
  operationId: string
  featureKey: string
  venueId?: string | null
  note?: string | null
  client?: DbClient
}) {
  const client = params.client ?? db
  const feature = BILLING_ADD_ON_CATALOG.find((candidate) => candidate.key === params.featureKey)
  if (!feature) throw new BillingServiceError('NOT_FOUND', 'This add-on is not available.')
  const request = await client.$transaction(async (tx) => {
    const replay = await tx.billingCustomerRequest.findFirst({
      where: { tenantId: params.tenantId, operationId: params.operationId },
    })
    if (replay) return replay
    const account = await tx.billingAccount.findUnique({ where: { tenantId: params.tenantId } })
    if (!account) throw new BillingServiceError('NOT_FOUND', 'No billing account is linked.')
    if (params.venueId) {
      const venue = await tx.venue.findFirst({
        where: { id: params.venueId, tenantId: params.tenantId },
        select: { id: true },
      })
      if (!venue) throw new BillingServiceError('FORBIDDEN', 'The selected venue is unavailable.')
    }
    const created = await tx.billingCustomerRequest.create({
      data: {
        operationId: params.operationId,
        tenantId: params.tenantId,
        billingAccountId: account.id,
        venueId: params.venueId ?? null,
        kind: 'ADD_ON_INTEREST',
        status: 'OPEN',
        requestedBy: params.actorId,
        reason: params.note ?? null,
        featureKey: feature.key,
        featureLabelSnapshot: feature.label,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: params.tenantId,
        actorId: params.actorId,
        actorRole: params.actorRole,
        action: 'billing.add-on-interest.recorded',
        targetType: 'BillingCustomerRequest',
        targetId: created.id,
        afterState: { featureKey: feature.key, venueId: params.venueId ?? null },
      },
      tx,
    )
    return created
  })
  await publishOperationalEvent({
    event: {
      tenantId: params.tenantId,
      ...(params.venueId ? { venueId: params.venueId } : {}),
      eventType: 'billing.add-on-interest',
      sourceSubsystem: 'billing',
      severity: 'INFO',
      title: `Customer is interested in ${feature.label}`,
      summary: 'Prepare a personalized offer and review it before any client email is sent.',
      actionRequired: true,
      recommendedAction: 'Open the linked CRM customer and draft a scoped commercial offer.',
      linkedObjectType: 'BillingCustomerRequest',
      linkedObjectId: request.id,
      deduplicationKey: `billing-add-on-interest:${request.id}`,
    },
  })
  return { request, feature }
}
