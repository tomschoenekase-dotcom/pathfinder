import { describe, expect, it } from 'vitest'

import { buildNativeContentReadSwitchContract } from './native-content-read-switch'

const exact = {
  targetReleaseId: 'release-1',
  convergence: { phase: 'NATIVE_HEAD_IN_SYNC' as const, head: { releaseId: 'release-1' } },
  shadowComparison: {
    status: 'COMPARABLE_WITH_DECLARED_CHANGE' as const,
    totals: { newFailures: 0, missingResults: 0 },
  },
}

describe('buildNativeContentReadSwitchContract', () => {
  it('keeps complete evidence policy-gated and preserves the compatibility rollback target', () => {
    expect(buildNativeContentReadSwitchContract(exact)).toEqual({
      contractVersion: 1,
      phase: 'POLICY_GATED',
      targetReleaseId: 'release-1',
      currentGuestReadPath: 'LEGACY_SEMANTIC_PLUS_NATIVE_GENERALIZED_PROMPT',
      proposedGuestReadPath: 'NATIVE_PRIMARY',
      evidenceComplete: true,
      executable: false,
      readyForProductionSwitch: false,
      blockers: [
        'QUALITY_THRESHOLD_POLICY_UNSET',
        'READ_EXECUTOR_NOT_IMPLEMENTED',
        'PRODUCTION_APPROVAL_REQUIRED',
        'ROLLBACK_RUNTIME_NOT_PROVEN',
      ],
      rollback: {
        targetGuestReadPath: 'LEGACY_SEMANTIC_PLUS_NATIVE_GENERALIZED_PROMPT',
        compatibilityDataRetentionRequired: true,
        rehearsalRequired: true,
        automaticExecutionAuthorized: false,
      },
    })
  })

  it('fails closed on drift, wrong head, missing results, and new failures', () => {
    const result = buildNativeContentReadSwitchContract({
      ...exact,
      convergence: { phase: 'NATIVE_HEAD_DRIFTED', head: { releaseId: 'release-2' } },
      shadowComparison: {
        status: 'COMPARABLE_WITH_DECLARED_CHANGE',
        totals: { newFailures: 2, missingResults: 1 },
      },
    })
    expect(result.phase).toBe('EVIDENCE_INCOMPLETE')
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'MATERIALIZED_STATE_DRIFT',
        'TARGET_RELEASE_NOT_ACTIVE_HEAD',
        'SHADOW_RESULTS_MISSING',
        'NEW_SHADOW_FAILURES',
      ]),
    )
    expect(result.executable).toBe(false)
  })

  it('does not treat an incomparable shadow run as usable evidence', () => {
    const result = buildNativeContentReadSwitchContract({
      ...exact,
      shadowComparison: { status: 'INCOMPARABLE', totals: null },
    })
    expect(result.evidenceComplete).toBe(false)
    expect(result.blockers).toEqual(
      expect.arrayContaining(['SHADOW_EVIDENCE_INCOMPARABLE', 'SHADOW_RESULTS_MISSING']),
    )
  })
})
