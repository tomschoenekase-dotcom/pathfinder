import { z } from 'zod'

export const LEGACY_GUEST_CONTENT_READ_PATH =
  'LEGACY_SEMANTIC_PLUS_NATIVE_GENERALIZED_PROMPT' as const
export const NATIVE_GUEST_CONTENT_READ_PATH =
  'NATIVE_HEAD_WITH_COMPATIBILITY_AUTHORIZATION' as const

/**
 * Venue-exact activation policy stored on the tenant feature-flag row whose key
 * includes the venue identifier. Evidence references are required so enabling a
 * boolean alone can never activate the native read path.
 */
export const NativeGuestReadPolicy = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(['DARK', 'ACTIVE']),
    venueId: z.string().trim().min(1).max(191),
    targetReleaseId: z.string().uuid(),
    evaluationEvidenceId: z.string().uuid(),
    qualityPolicyRef: z.string().trim().min(1).max(500),
    rollbackRehearsalRef: z.string().trim().min(1).max(500),
    productionApprovalRef: z.string().trim().min(1).max(500).nullable(),
  })
  .strict()
export type NativeGuestReadPolicy = z.infer<typeof NativeGuestReadPolicy>

export type NativeContentReadSwitchBlocker =
  | 'NO_NATIVE_HEAD'
  | 'INVALID_NATIVE_HEAD'
  | 'MATERIALIZED_STATE_DRIFT'
  | 'TARGET_RELEASE_NOT_ACTIVE_HEAD'
  | 'SHADOW_EVIDENCE_INCOMPARABLE'
  | 'SHADOW_RESULTS_MISSING'
  | 'NEW_SHADOW_FAILURES'
  | 'QUALITY_THRESHOLD_POLICY_UNSET'
  | 'PRODUCTION_APPROVAL_REQUIRED'
  | 'ROLLBACK_RUNTIME_NOT_PROVEN'

type Convergence = {
  phase: 'NO_NATIVE_HEAD' | 'NATIVE_HEAD_INVALID' | 'NATIVE_HEAD_DRIFTED' | 'NATIVE_HEAD_IN_SYNC'
  head: { releaseId: string } | null
}

type ShadowComparison = {
  status: 'INCOMPARABLE' | 'COMPARABLE' | 'COMPARABLE_WITH_DECLARED_CHANGE'
  totals: null | { newFailures: number; missingResults: number }
}

/**
 * Builds a deterministic, non-executable read-switch contract preview.
 *
 * The retained blockers are intentional founder-policy boundaries. This helper
 * must not turn evidence into production authority or infer unresolved quality
 * thresholds. Compatibility content remains the mandatory rollback target.
 */
export function buildNativeContentReadSwitchContract(input: {
  targetReleaseId: string
  convergence: Convergence
  shadowComparison: ShadowComparison
}) {
  const blockers = new Set<NativeContentReadSwitchBlocker>()
  if (input.convergence.phase === 'NO_NATIVE_HEAD') blockers.add('NO_NATIVE_HEAD')
  if (input.convergence.phase === 'NATIVE_HEAD_INVALID') blockers.add('INVALID_NATIVE_HEAD')
  if (input.convergence.phase === 'NATIVE_HEAD_DRIFTED') blockers.add('MATERIALIZED_STATE_DRIFT')
  if (input.convergence.head?.releaseId !== input.targetReleaseId)
    blockers.add('TARGET_RELEASE_NOT_ACTIVE_HEAD')
  if (input.shadowComparison.status === 'INCOMPARABLE') blockers.add('SHADOW_EVIDENCE_INCOMPARABLE')
  if (!input.shadowComparison.totals || input.shadowComparison.totals.missingResults > 0)
    blockers.add('SHADOW_RESULTS_MISSING')
  if ((input.shadowComparison.totals?.newFailures ?? 0) > 0) blockers.add('NEW_SHADOW_FAILURES')

  const evidenceComplete = blockers.size === 0
  blockers.add('QUALITY_THRESHOLD_POLICY_UNSET')
  blockers.add('PRODUCTION_APPROVAL_REQUIRED')
  blockers.add('ROLLBACK_RUNTIME_NOT_PROVEN')

  return {
    contractVersion: 1 as const,
    phase: evidenceComplete ? ('POLICY_GATED' as const) : ('EVIDENCE_INCOMPLETE' as const),
    targetReleaseId: input.targetReleaseId,
    currentGuestReadPath: LEGACY_GUEST_CONTENT_READ_PATH,
    proposedGuestReadPath: NATIVE_GUEST_CONTENT_READ_PATH,
    evidenceComplete,
    executable: false as const,
    readyForProductionSwitch: false as const,
    blockers: [...blockers],
    rollback: {
      targetGuestReadPath: LEGACY_GUEST_CONTENT_READ_PATH,
      compatibilityDataRetentionRequired: true as const,
      rehearsalRequired: true as const,
      automaticExecutionAuthorized: false as const,
    },
  }
}
