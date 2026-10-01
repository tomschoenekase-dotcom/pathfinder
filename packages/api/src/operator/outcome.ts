import type { OperatorEffect } from '@pathfinder/contracts/operator-mcp'

/**
 * Failure codes recorded only by checks that run before any domain write begins. A FAILED
 * proposal with one of these provably changed nothing. Any other FAILED code can come from an error
 * thrown after the domain write began, so its effect is `unknown` until the target is read.
 */
const PRE_EFFECT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'GRANT_REVOKED',
  'UNKNOWN_KIND',
  'NOT_REVERTIBLE',
  'REFERENCE_UNRESOLVED',
  'PLAN_STOPPED',
  'TARGET_CHANGED',
  'NOT_FOUND',
])

type EffectInput = Readonly<{
  status: string
  applyClaimedAt: Date | null
  failureCode: string | null
}>

/** What recorded state proves about whether one proposal's change reached the system. */
export function proposalEffect(row: EffectInput): OperatorEffect {
  switch (row.status) {
    case 'APPLIED':
      return 'applied'
    case 'FAILED':
      return row.failureCode !== null && PRE_EFFECT_FAILURE_CODES.has(row.failureCode)
        ? 'none'
        : 'unknown'
    case 'STALE':
    case 'REJECTED':
    case 'EXPIRED':
    case 'PENDING':
      return 'none'
    default:
      // APPROVED: a claimed apply that has not recorded a result is in flight or was interrupted.
      return row.applyClaimedAt === null ? 'none' : 'unknown'
  }
}

/** A plan's effect from its steps, never from the plan's own status alone. */
export function planEffect(steps: readonly EffectInput[]): OperatorEffect {
  const effects = steps.map(proposalEffect)
  const applied = effects.filter((effect) => effect === 'applied').length
  if (effects.length > 0 && applied === effects.length) return 'applied'
  if (applied > 0) return 'partial'
  if (effects.includes('unknown')) return 'unknown'
  return 'none'
}
