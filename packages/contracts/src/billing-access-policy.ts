export type BillingAccessPolicyInput = {
  billingMode:
    | 'STRIPE_SUBSCRIPTION'
    | 'STRIPE_INVOICE'
    | 'MANUAL_INVOICE'
    | 'COMPLIMENTARY'
    | 'PILOT'
    | 'NO_BILLING_REQUIRED'
  arrangementStatus:
    | 'DRAFT'
    | 'PENDING'
    | 'TRIALING'
    | 'ACTIVE'
    | 'PAST_DUE'
    | 'UNPAID'
    | 'CANCELED'
    | 'ENDED'
    | 'PAUSED'
    | 'MANUAL_REVIEW'
  providerSubscriptionStatus?:
    | 'INCOMPLETE'
    | 'INCOMPLETE_EXPIRED'
    | 'TRIALING'
    | 'ACTIVE'
    | 'PAST_DUE'
    | 'CANCELED'
    | 'UNPAID'
    | 'PAUSED'
    | null
  paidThrough?: Date | null
  accessStartsAt?: Date | null
  accessEndsAt?: Date | null
  graceEndsAt?: Date | null
  cancelAtPeriodEnd?: boolean
  disputeOpen?: boolean
  override?: { reason: string; expiresAt: Date; grantsAccess: boolean } | null
  now?: Date
}

export type BillingAccessState =
  | 'PENDING'
  | 'ACTIVE'
  | 'GRACE_PERIOD'
  | 'PAID_THROUGH'
  | 'SUSPENDED'
  | 'ENDED'
  | 'MANUAL_REVIEW'
export type BillingAccessDecision = {
  state: BillingAccessState
  entitlementsActive: boolean
  source:
    | 'OVERRIDE'
    | 'MANUAL_REVIEW'
    | 'NO_BILLING_REQUIRED'
    | 'COMPLIMENTARY_OR_PILOT'
    | 'STRIPE_OR_INVOICE'
  validUntil: Date | null
  reason: string
}

/** The one domain policy translating durable commercial evidence into access. */
export function evaluateBillingAccess(input: BillingAccessPolicyInput): BillingAccessDecision {
  const now = input.now ?? new Date()
  if (input.override && input.override.expiresAt > now)
    return {
      state: input.override.grantsAccess ? 'ACTIVE' : 'SUSPENDED',
      entitlementsActive: input.override.grantsAccess,
      source: 'OVERRIDE',
      validUntil: input.override.expiresAt,
      reason: input.override.reason,
    }
  if (input.disputeOpen || input.arrangementStatus === 'MANUAL_REVIEW')
    return {
      state: 'MANUAL_REVIEW',
      entitlementsActive: false,
      source: 'MANUAL_REVIEW',
      validUntil: null,
      reason: input.disputeOpen
        ? 'An open payment dispute requires operator review'
        : 'Operator review required',
    }
  if (input.billingMode === 'NO_BILLING_REQUIRED')
    return {
      state: 'ACTIVE',
      entitlementsActive: true,
      source: 'NO_BILLING_REQUIRED',
      validUntil: input.accessEndsAt ?? null,
      reason: 'The tenant is explicitly exempt from billing',
    }
  if (input.billingMode === 'COMPLIMENTARY' || input.billingMode === 'PILOT') {
    if (input.accessStartsAt && input.accessStartsAt > now)
      return {
        state: 'PENDING',
        entitlementsActive: false,
        source: 'COMPLIMENTARY_OR_PILOT',
        validUntil: input.accessStartsAt,
        reason: 'The approved access period has not started',
      }
    const active = Boolean(input.accessEndsAt && input.accessEndsAt > now)
    return {
      state: active ? 'ACTIVE' : 'ENDED',
      entitlementsActive: active,
      source: 'COMPLIMENTARY_OR_PILOT',
      validUntil: input.accessEndsAt ?? null,
      reason: active
        ? 'The approved access period is active'
        : 'The approved access period has expired',
    }
  }
  if (input.arrangementStatus === 'DRAFT' || input.arrangementStatus === 'PENDING')
    return {
      state: 'PENDING',
      entitlementsActive: false,
      source: 'STRIPE_OR_INVOICE',
      validUntil: null,
      reason: 'Billing confirmation is pending',
    }
  if (input.cancelAtPeriodEnd || input.arrangementStatus === 'CANCELED') {
    const paidThrough = Boolean(input.paidThrough && input.paidThrough > now)
    return {
      state: paidThrough ? 'PAID_THROUGH' : 'ENDED',
      entitlementsActive: paidThrough,
      source: 'STRIPE_OR_INVOICE',
      validUntil: input.paidThrough ?? null,
      reason: paidThrough
        ? 'Cancellation is scheduled after the paid-through period'
        : 'The paid-through period ended',
    }
  }
  if (
    input.arrangementStatus === 'ACTIVE' &&
    (!input.providerSubscriptionStatus || input.providerSubscriptionStatus === 'ACTIVE')
  )
    return {
      state: 'ACTIVE',
      entitlementsActive: true,
      source: 'STRIPE_OR_INVOICE',
      validUntil: input.paidThrough ?? null,
      reason: 'The commercial arrangement is current',
    }
  if (input.arrangementStatus === 'PAST_DUE' || input.providerSubscriptionStatus === 'PAST_DUE') {
    const inGrace = Boolean(input.graceEndsAt && input.graceEndsAt > now)
    return {
      state: inGrace ? 'GRACE_PERIOD' : 'SUSPENDED',
      entitlementsActive: inGrace,
      source: 'STRIPE_OR_INVOICE',
      validUntil: input.graceEndsAt ?? null,
      reason: inGrace
        ? 'Payment recovery grace period is active'
        : 'The payment recovery grace period ended',
    }
  }
  const ended =
    input.arrangementStatus === 'ENDED' ||
    input.providerSubscriptionStatus === 'CANCELED' ||
    input.providerSubscriptionStatus === 'INCOMPLETE_EXPIRED'
  return {
    state: ended ? 'ENDED' : 'SUSPENDED',
    entitlementsActive: false,
    source: 'STRIPE_OR_INVOICE',
    validUntil: null,
    reason: ended
      ? 'The commercial arrangement ended'
      : 'Paid entitlements are suspended pending recovery',
  }
}

export function customerPortalPolicy(input: {
  minimumCommitmentEndsAt?: Date | null
  planChangesEnabled: boolean
  now?: Date
}) {
  const now = input.now ?? new Date()
  const minimumTermActive = Boolean(
    input.minimumCommitmentEndsAt && input.minimumCommitmentEndsAt > now,
  )
  return {
    minimumTermActive,
    allowPortal: true,
    allowCancellation: !minimumTermActive,
    allowPlanChanges: input.planChangesEnabled && !minimumTermActive,
    supportRequired: minimumTermActive,
  }
}
