export type PaymentRecoveryInvoiceEvidence = {
  status: 'DRAFT' | 'OPEN' | 'PAID' | 'UNCOLLECTIBLE' | 'VOID'
  amountRemainingMinor: bigint
  currency: string
  dueAt?: Date | null
  failedAt?: Date | null
  nextRetryAt?: Date | null
}

export type PaymentRecoveryAgreementEvidence = {
  agreedAmountMinor: bigint | null
  currency: string
  billingInterval: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR' | 'CUSTOM'
  billingIntervalCount: number
} | null

export type PaymentRecoveryRelationshipEvidence = {
  organizationId: string
  organizationName: string
  relationshipTier: string | null
  relationshipStartedAt: Date
} | null

export type PaymentRecoveryContextInput = {
  accountStatus:
    | 'UNCONFIGURED'
    | 'PENDING'
    | 'ACTIVE'
    | 'PAST_DUE'
    | 'UNPAID'
    | 'CANCELED'
    | 'ENDED'
    | 'PAUSED'
    | 'MANUAL_REVIEW'
  gracePeriodEndsAt?: Date | null
  agreement: PaymentRecoveryAgreementEvidence
  invoices: readonly PaymentRecoveryInvoiceEvidence[]
  relationship: PaymentRecoveryRelationshipEvidence
  ongoingVariableCostMinor?: bigint | null
  variableCostCurrency?: string | null
  variableCostAsOf?: Date | null
  priorCommunicationAt?: Date | null
  priorCommunicationSummary?: string | null
  now?: Date
}

export type PaymentRecoveryContext = ReturnType<typeof buildPaymentRecoveryContext>

const DAY_MS = 86_400_000
const RECOVERY_STATUSES = new Set(['PAST_DUE', 'UNPAID', 'MANUAL_REVIEW'])

function normalizedCurrency(value: string): string {
  return value.trim().toLowerCase()
}

function earliest(values: Array<Date | null | undefined>): Date | null {
  return (
    values
      .filter((value): value is Date => value instanceof Date)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? null
  )
}

/**
 * Builds a score-free, provider-dark payment-recovery brief from durable facts.
 *
 * This projection intentionally does not choose a grace period, rank customers,
 * authorize communication, or suspend service. Missing commercial context stays
 * visible instead of being replaced with guessed values.
 */
export function buildPaymentRecoveryContext(input: PaymentRecoveryContextInput) {
  const now = input.now ?? new Date()
  const recoveryRequired = RECOVERY_STATUSES.has(input.accountStatus)
  const relevantInvoices = input.invoices.filter(
    (invoice) =>
      invoice.amountRemainingMinor > 0n &&
      (invoice.status === 'OPEN' || invoice.status === 'UNCOLLECTIBLE'),
  )
  const receivableByCurrency = new Map<string, bigint>()
  for (const invoice of relevantInvoices) {
    const currency = normalizedCurrency(invoice.currency)
    receivableByCurrency.set(
      currency,
      (receivableByCurrency.get(currency) ?? 0n) + invoice.amountRemainingMinor,
    )
  }
  const delinquentSince = earliest(
    relevantInvoices.flatMap((invoice) => [invoice.failedAt, invoice.dueAt]),
  )
  const nextRetryAt = earliest(relevantInvoices.map((invoice) => invoice.nextRetryAt))
  const daysDelinquent = delinquentSince
    ? Math.max(0, Math.floor((now.getTime() - delinquentSince.getTime()) / DAY_MS))
    : null
  const graceState = !recoveryRequired
    ? ('NOT_APPLICABLE' as const)
    : !input.gracePeriodEndsAt
      ? ('NOT_RECORDED' as const)
      : input.gracePeriodEndsAt > now
        ? ('ACTIVE' as const)
        : ('EXPIRED' as const)
  const state =
    input.accountStatus === 'MANUAL_REVIEW'
      ? ('MANUAL_REVIEW' as const)
      : input.accountStatus === 'UNPAID'
        ? ('UNPAID_REVIEW' as const)
        : input.accountStatus === 'PAST_DUE'
          ? ('PAYMENT_RECOVERY' as const)
          : ('NOT_REQUIRED' as const)
  const variableCostKnown =
    input.ongoingVariableCostMinor !== undefined &&
    input.ongoingVariableCostMinor !== null &&
    Boolean(input.variableCostCurrency)
  const priorCommunicationKnown = Boolean(
    input.priorCommunicationAt && input.priorCommunicationSummary?.trim(),
  )
  const missingEvidence = [
    ...(input.agreement?.agreedAmountMinor === null || !input.agreement ? ['ACCOUNT_VALUE'] : []),
    ...(!variableCostKnown ? ['ONGOING_VARIABLE_COST'] : []),
    ...(!input.relationship ? ['RELATIONSHIP_CONTEXT'] : []),
    ...(!priorCommunicationKnown ? ['PRIOR_COMMUNICATION'] : []),
  ] as Array<
    'ACCOUNT_VALUE' | 'ONGOING_VARIABLE_COST' | 'RELATIONSHIP_CONTEXT' | 'PRIOR_COMMUNICATION'
  >

  return {
    schemaVersion: 'torchiko-payment-recovery-context-v1' as const,
    generatedAt: now,
    state,
    reviewRequired: recoveryRequired,
    policy: {
      relationshipPreserving: true as const,
      automaticRestrictionAuthorized: false as const,
      automaticCustomerContactAuthorized: false as const,
      graceAndCutoffPolicy: 'UNRESOLVED' as const,
    },
    timing: {
      delinquentSince,
      daysDelinquent,
      nextRetryAt,
      gracePeriodEndsAt: input.gracePeriodEndsAt ?? null,
      graceState,
    },
    accountValue: input.agreement
      ? {
          amountMinor: input.agreement.agreedAmountMinor,
          currency: normalizedCurrency(input.agreement.currency),
          interval: input.agreement.billingInterval,
          intervalCount: input.agreement.billingIntervalCount,
          source: 'COMMERCIAL_AGREEMENT' as const,
        }
      : null,
    financialExposure: {
      receivableAtRiskByCurrency: [...receivableByCurrency.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, amountMinor]) => ({ currency, amountMinor })),
      ongoingVariableCost: variableCostKnown
        ? {
            amountMinor: input.ongoingVariableCostMinor!,
            currency: normalizedCurrency(input.variableCostCurrency!),
            asOf: input.variableCostAsOf ?? null,
          }
        : null,
      complete: variableCostKnown,
    },
    relationship: input.relationship,
    priorCommunication: priorCommunicationKnown
      ? {
          occurredAt: input.priorCommunicationAt!,
          summary: input.priorCommunicationSummary!.trim(),
        }
      : null,
    missingEvidence,
    recommendedNextStep: recoveryRequired
      ? 'Review the durable payment, relationship, cost, and communication evidence before choosing any consequential action.'
      : 'No payment-recovery action is indicated by the current billing state.',
  }
}
