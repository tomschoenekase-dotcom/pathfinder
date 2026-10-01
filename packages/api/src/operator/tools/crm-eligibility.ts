import {
  evaluateProspectContactEligibility,
  type ProspectEligibilityPurpose,
  type ProspectEligibilityReason,
} from '@pathfinder/db'

type AddressRow = Parameters<typeof evaluateProspectContactEligibility>[0] & {
  id: string
  organizationId: string
  archivedAt: Date | null
  organization: { archivedAt: Date | null; opportunity: { stage: string } | null }
}

/** Reasons that mean the address itself is refused, whichever record carries them. */
const BLOCKING: ReadonlySet<ProspectEligibilityReason> = new Set([
  'do_not_contact',
  'organization_do_not_contact',
  'suppressed',
  'unsubscribed',
  'complained',
  'bounced',
  'opted_out',
  'prohibited',
  'invalid_address',
])

export type AddressEligibility = Readonly<{
  allowed: boolean
  reason: ProspectEligibilityReason | 'ok' | 'unknown_address'
  reasons: readonly string[]
  purpose: ProspectEligibilityPurpose
  organizationId: string | null
  contactId: string | null
}>

/**
 * Decides one address from every contact row that carries it, archived rows included, under the
 * same rule canonical drafting, staging and release use. One blocking row anywhere refuses the
 * address; otherwise it needs a live row (and, for sending, a verified one). Callers must pass
 * every row: a capped list would let a block on an old alias go unseen.
 */
export function evaluateAddress(
  rows: readonly AddressRow[],
  purpose: ProspectEligibilityPurpose,
): AddressEligibility {
  if (rows.length === 0) {
    return {
      allowed: false,
      reason: 'unknown_address',
      reasons: ['unknown_address'],
      purpose,
      organizationId: null,
      contactId: null,
    }
  }
  const evaluated = rows.map((row) => ({
    row,
    result: evaluateProspectContactEligibility(row, purpose, {
      organizationStage: row.organization.opportunity?.stage ?? null,
    }),
    live: row.archivedAt === null && row.organization.archivedAt === null,
  }))
  // A block on any row refuses the address; live rows are reported first.
  const blocked = evaluated
    .filter((entry) => entry.result.reasons.some((reason) => BLOCKING.has(reason)))
    .sort((a, b) => Number(b.live) - Number(a.live))[0]
  if (blocked) {
    const reasons = blocked.result.reasons.filter((reason) => BLOCKING.has(reason))
    return {
      allowed: false,
      reason: reasons[0]!,
      reasons,
      purpose,
      organizationId: blocked.row.organizationId,
      contactId: blocked.row.id,
    }
  }
  const live = evaluated.filter((entry) => entry.live)
  if (live.length === 0) {
    return {
      allowed: false,
      reason: 'unknown_address',
      reasons: ['archived'],
      purpose,
      organizationId: null,
      contactId: null,
    }
  }
  // Any live row that satisfies the purpose is enough; otherwise report why the best one fails.
  const good = live.find((entry) => entry.result.eligible)
  if (good) {
    return {
      allowed: true,
      reason: 'ok',
      reasons: [],
      purpose,
      organizationId: good.row.organizationId,
      contactId: good.row.id,
    }
  }
  const first = live[0]!
  return {
    allowed: false,
    reason: first.result.reasons[0] ?? 'not_verified',
    reasons: first.result.reasons,
    purpose,
    organizationId: first.row.organizationId,
    contactId: first.row.id,
  }
}
