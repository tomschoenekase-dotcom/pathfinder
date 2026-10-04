import { createHash } from 'node:crypto'

/**
 * Pure rules for executing an approved offboarding plan. No database, no provider, no clock: the
 * operator layer reads the facts and these functions decide. Executing a plan switches things off
 * and records what a person must still do; it never deletes data and never calls a payment or
 * identity provider.
 */

export const OFFBOARDING_EXECUTION_STEP_KEYS = [
  'PUBLIC_ACCESS',
  'SCHEDULED_WORK',
  'CONNECTIONS',
  'MEMBER_ACCESS',
  'BILLING',
  'IDENTITY_PROVIDER',
  'DATA_MANIFEST',
] as const
export type OffboardingExecutionStepKeyName = (typeof OFFBOARDING_EXECUTION_STEP_KEYS)[number]

export type OffboardingRevocationTargetName =
  | 'GUEST_LINKS'
  | 'WIDGETS'
  | 'PARTNER_API_KEYS'
  | 'MCP_CREDENTIALS'
  | 'BACKGROUND_JOBS'
  | 'AGENT_IDENTITIES'
  | 'CLIENT_ACCESS'
  | 'OPERATOR_IMPERSONATION'

/**
 * The plan names what it intends to revoke. A step runs only when the plan asked for at least one
 * of its targets; the three human-facing steps (billing, identity provider, manifest) always run
 * because they only record. OPERATOR_IMPERSONATION is a platform capability and is never revoked
 * here, so it maps to no step.
 */
export const STEP_REVOCATION_TARGETS: Readonly<
  Record<
    'PUBLIC_ACCESS' | 'SCHEDULED_WORK' | 'CONNECTIONS' | 'MEMBER_ACCESS',
    readonly OffboardingRevocationTargetName[]
  >
> = {
  PUBLIC_ACCESS: ['GUEST_LINKS', 'WIDGETS'],
  SCHEDULED_WORK: ['BACKGROUND_JOBS'],
  CONNECTIONS: ['PARTNER_API_KEYS', 'MCP_CREDENTIALS', 'AGENT_IDENTITIES'],
  MEMBER_ACCESS: ['CLIENT_ACCESS'],
}

export type OffboardingEffectStepKey = keyof typeof STEP_REVOCATION_TARGETS

export function isEffectStep(
  key: OffboardingExecutionStepKeyName,
): key is OffboardingEffectStepKey {
  return key in STEP_REVOCATION_TARGETS
}

/** The plan targets a step covers, restricted to what the plan actually selected. */
export function plannedTargetsForStep(
  key: OffboardingExecutionStepKeyName,
  plannedTargets: readonly string[],
): OffboardingRevocationTargetName[] {
  if (!isEffectStep(key)) return []
  return STEP_REVOCATION_TARGETS[key].filter((target) => plannedTargets.includes(target))
}

export function isStepPlanned(
  key: OffboardingExecutionStepKeyName,
  plannedTargets: readonly string[],
): boolean {
  return !isEffectStep(key) || plannedTargetsForStep(key, plannedTargets).length > 0
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

/** Account or agreement states where a paid arrangement may still be running at the provider. */
const LIVE_BILLING_STATUSES: ReadonlySet<string> = new Set([
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'UNPAID',
  'PAUSED',
  'MANUAL_REVIEW',
])
const PAID_BILLING_MODES: ReadonlySet<string> = new Set([
  'STRIPE_SUBSCRIPTION',
  'STRIPE_INVOICE',
  'MANUAL_INVOICE',
])

export type OffboardingBillingFacts = {
  accountStatus: string | null
  accountBillingMode: string | null
  agreements: ReadonlyArray<{
    status: string
    billingMode: string
    hasProviderSubscription: boolean
  }>
}

/**
 * Whether a paying arrangement may still be live. Complimentary, pilot and no-billing arrangements
 * never block. A live provider subscription always blocks, whatever the recorded mode says.
 */
export function billingBlocksOffboarding(facts: OffboardingBillingFacts): {
  blocks: boolean
  reasons: string[]
} {
  const reasons: string[] = []
  if (
    facts.accountStatus !== null &&
    LIVE_BILLING_STATUSES.has(facts.accountStatus) &&
    facts.accountBillingMode !== null &&
    PAID_BILLING_MODES.has(facts.accountBillingMode)
  ) {
    reasons.push(`billing account ${facts.accountStatus}`)
  }
  for (const agreement of facts.agreements) {
    if (!LIVE_BILLING_STATUSES.has(agreement.status)) continue
    if (PAID_BILLING_MODES.has(agreement.billingMode) || agreement.hasProviderSubscription) {
      reasons.push(`agreement ${agreement.status}`)
    }
  }
  return { blocks: reasons.length > 0, reasons }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type OffboardingExecutionRefusalCode =
  | 'PLAN_NOT_APPROVED'
  | 'PLAN_SCOPE_INCOMPLETE'
  | 'BILLING_ACTIVE'
  | 'EXECUTION_CLOSED'

export type OffboardingGateInput = {
  planStatus: string
  planVenueIds: readonly string[]
  tenantVenueIds: readonly string[]
  executionStatus: 'IN_PROGRESS' | 'COMPLETED' | 'REINSTATED' | null
  billing: OffboardingBillingFacts
  /** The person recorded that billing is dealt with (a note is required alongside). */
  billingHandled: boolean
}

export type OffboardingGateResult =
  | { ok: true }
  | { ok: false; code: OffboardingExecutionRefusalCode; message: string }

/**
 * A plan may be executed only when a person reviewed it, it covers every venue of the customer
 * (offboarding switches off customer-wide access, so a partial plan is never enough), no earlier
 * execution of it was reinstated, and any live paid arrangement was explicitly handled.
 */
export function evaluateOffboardingGate(input: OffboardingGateInput): OffboardingGateResult {
  if (input.planStatus !== 'REVIEWED' && input.planStatus !== 'EXPORT_READY') {
    return {
      ok: false,
      code: 'PLAN_NOT_APPROVED',
      message: 'The offboarding plan has not been reviewed, or was cancelled.',
    }
  }
  if (input.executionStatus === 'REINSTATED') {
    return {
      ok: false,
      code: 'EXECUTION_CLOSED',
      message: 'This plan was executed and then reinstated. Create a new plan to offboard again.',
    }
  }
  const planned = new Set(input.planVenueIds)
  const missing = input.tenantVenueIds.filter((venueId) => !planned.has(venueId))
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'PLAN_SCOPE_INCOMPLETE',
      message: `The plan does not cover every venue of this customer (${missing.length} not covered). Create a plan that includes all of them.`,
    }
  }
  const billing = billingBlocksOffboarding(input.billing)
  if (billing.blocks && !input.billingHandled) {
    return {
      ok: false,
      code: 'BILLING_ACTIVE',
      message: `A paid arrangement may still be live (${billing.reasons.join(', ')}). Cancel or settle it first, then propose again with billingHandled and a note saying what was done.`,
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Deterministic identities and manifest integrity
// ---------------------------------------------------------------------------

/** A stable UUID for one effect, so a retried step reuses the same operation identity. */
export function offboardingDerivedUuid(seed: string): string {
  const hex = createHash('sha256').update(`offboarding-execution:${seed}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Canonical JSON hash of the manifest counts, so a later reader can tell the manifest changed. */
export function offboardingManifestHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonical(item)]),
      )
    }
    return input
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

/** Things this system deliberately does not decide. Recorded so a person can pick them up. */
export const OFFBOARDING_FUTURE_DECISIONS = [
  'Retention and deletion of this customer data: not decided and not performed. Tom decides, then a separate reviewed step does it.',
] as const
