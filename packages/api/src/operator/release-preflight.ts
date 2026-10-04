/**
 * Release preflight: every unmet prerequisite before a release or package draft could go live,
 * each with a plain reason and the action that clears it. The evaluation is a pure function of
 * facts read from canonical state, so it never publishes, approves or activates anything, and an
 * unmeasurable fact is reported as unmet rather than assumed fine.
 */

export type PreflightTarget =
  | {
      kind: 'NATIVE_RELEASE'
      id: string
      status: 'DRAFT' | 'APPROVED' | 'APPLIED' | 'REVERTED'
      isNativeHead: boolean
    }
  | {
      kind: 'PACKAGE_DRAFT'
      id: string
      status: 'DRAFT' | 'APPROVED' | 'APPLIED' | 'REVERTED'
      validationErrors: number | null
      validationWarnings: number | null
      duplicateScanComplete: boolean | null
    }

export type PreflightFacts = {
  venueActive: boolean
  publicPlaces: number
  publicKnowledgeEntries: number
  target: PreflightTarget | null
  /** Native guest read activation blockers, as the existing assessment names them. */
  nativeReadBlockers: readonly string[] | null
  convergencePhase: string | null
  previewSigningConfigured: boolean
  websiteDistribution: 'ENABLED' | 'DISABLED' | null
}

export type PreflightPrerequisite = {
  key: string
  passed: boolean
  severity: 'BLOCKER' | 'INFO'
  reason: string
  action: string
}

const NATIVE_READ_GUIDANCE: Record<string, { reason: string; action: string }> = {
  SERVER_GATE_DISABLED: {
    reason: 'The server gate for native guest reads is off on this deployment.',
    action:
      'Guests keep reading the compatibility rows. Enabling the gate is a deployment decision for a person.',
  },
  VENUE_POLICY_MISSING: {
    reason: 'This venue has no native guest read policy.',
    action: 'A person records the policy in the venue native-read settings; the operator cannot.',
  },
  VENUE_POLICY_DISABLED: {
    reason: 'The venue native guest read policy is disabled.',
    action: 'A person enables it after reviewing the evaluation evidence.',
  },
  VENUE_POLICY_INVALID: {
    reason: 'The venue native guest read policy is invalid.',
    action:
      'A person corrects the policy; read venues.get_effective_guest_version for the current path.',
  },
  PRODUCTION_APPROVAL_REQUIRED: {
    reason: 'Production approval for native reads is not recorded.',
    action:
      'A person records the approval reference before native values can be served in production.',
  },
  TARGET_RELEASE_NOT_ACTIVE_HEAD: {
    reason: 'The release named by the native read policy is not the active native head.',
    action:
      'Apply the intended release through the approved release path, or correct the policy target.',
  },
  NATIVE_HEAD_INVALID: {
    reason: 'The native deployment head is missing or invalid.',
    action: 'Apply an approved native release so a valid head exists.',
  },
  EVALUATION_EVIDENCE_INVALID: {
    reason: 'The evaluation evidence for the release is missing or invalid.',
    action: 'Run and record the release evaluation; do not infer quality from its absence.',
  },
  READ_FAILED_CLOSED: {
    reason:
      'The native read state could not be read, so it fails closed to the compatibility path.',
    action:
      'Retry; if it persists, report it. Guests are unaffected and keep the compatibility path.',
  },
}

export function evaluatePreflight(facts: PreflightFacts): PreflightPrerequisite[] {
  const items: PreflightPrerequisite[] = []
  const add = (item: PreflightPrerequisite) => items.push(item)

  add({
    key: 'venue_active',
    passed: facts.venueActive,
    severity: 'BLOCKER',
    reason: facts.venueActive
      ? 'The venue is active.'
      : 'The venue is not active, so guests cannot reach it on the public route whatever is released.',
    action: facts.venueActive
      ? 'None.'
      : 'Propose venues.propose_publish (availability only) after the content checks pass.',
  })
  const content = facts.publicPlaces + facts.publicKnowledgeEntries
  add({
    key: 'public_content_present',
    passed: content > 0,
    severity: 'BLOCKER',
    reason:
      content > 0
        ? `${facts.publicPlaces} public places and ${facts.publicKnowledgeEntries} public knowledge entries are active.`
        : 'No active public place or knowledge entry exists, so the guide would have nothing to say.',
    action:
      content > 0
        ? 'None.'
        : 'Add content through venues.propose_content_changeset or an approved package.',
  })

  const target = facts.target
  if (target === null) {
    add({
      key: 'release_selected',
      passed: false,
      severity: 'INFO',
      reason:
        'No release or package draft was named, so only venue-level prerequisites were checked.',
      action: 'Call again with releaseKind and releaseId (see venues.list_releases).',
    })
  } else if (target.kind === 'NATIVE_RELEASE') {
    add({
      key: 'release_status',
      passed: target.status === 'APPROVED' || target.status === 'APPLIED',
      severity: 'BLOCKER',
      reason:
        target.status === 'DRAFT'
          ? 'The release is a DRAFT and has not been approved.'
          : target.status === 'REVERTED'
            ? 'The release was reverted and cannot be applied again.'
            : `The release is ${target.status}.`,
      action:
        target.status === 'DRAFT'
          ? 'A person approves the release through the approved release path.'
          : target.status === 'REVERTED'
            ? 'Create a new release from current content.'
            : 'None.',
    })
    add({
      key: 'release_is_head',
      passed: target.isNativeHead,
      severity: 'INFO',
      reason: target.isNativeHead
        ? 'This release is the native head.'
        : 'This release is not the native head, so guests are not served from it.',
      action: target.isNativeHead
        ? 'None.'
        : 'A person applies it through the approved release path when ready.',
    })
  } else {
    add({
      key: 'package_status',
      passed: target.status === 'APPROVED' || target.status === 'APPLIED',
      severity: 'BLOCKER',
      reason:
        target.status === 'DRAFT'
          ? 'The package is a DRAFT and has not been approved.'
          : target.status === 'REVERTED'
            ? 'The package was reverted.'
            : `The package is ${target.status}.`,
      action:
        target.status === 'DRAFT'
          ? 'A person reviews and approves the package.'
          : target.status === 'REVERTED'
            ? 'Create a new package draft from current content.'
            : 'None.',
    })
    add({
      key: 'package_validation',
      passed: target.validationErrors === 0,
      severity: 'BLOCKER',
      reason:
        target.validationErrors === null
          ? 'The stored validation report could not be read.'
          : target.validationErrors === 0
            ? `Validation has no errors (${target.validationWarnings ?? 0} warnings).`
            : `Validation reports ${target.validationErrors} error(s).`,
      action:
        target.validationErrors === 0
          ? 'Review any warnings before approval.'
          : 'Fix the reported errors and create a fresh package draft.',
    })
    add({
      key: 'package_duplicate_scan',
      passed: target.duplicateScanComplete === true,
      severity: 'BLOCKER',
      reason:
        target.duplicateScanComplete === true
          ? 'The semantic duplicate scan completed.'
          : 'The semantic duplicate scan did not complete, so contradictions may be undetected.',
      action:
        target.duplicateScanComplete === true
          ? 'None.'
          : 'Re-run the package analysis before approval.',
    })
  }

  if (facts.convergencePhase !== null) {
    const inSync = facts.convergencePhase === 'NATIVE_HEAD_IN_SYNC'
    add({
      key: 'content_converged',
      passed: inSync,
      severity: 'INFO',
      reason: inSync
        ? 'Live content matches the native head.'
        : `Native content convergence is ${facts.convergencePhase}.`,
      action: inSync
        ? 'None.'
        : 'Read venues.get_effective_guest_version. Drift between live rows and the head is resolved by a person.',
    })
  }
  if (facts.nativeReadBlockers !== null) {
    for (const blocker of facts.nativeReadBlockers) {
      const guidance = NATIVE_READ_GUIDANCE[blocker] ?? {
        reason: `Native guest read is blocked (${blocker.toLowerCase()}).`,
        action: 'Read venues.get_effective_guest_version and ask a person.',
      }
      add({
        key: `native_read_${blocker.toLowerCase()}`,
        passed: false,
        severity: 'INFO',
        reason: `${guidance.reason} This matters only if guests should be served native values.`,
        action: guidance.action,
      })
    }
  }
  add({
    key: 'private_preview_available',
    passed: facts.previewSigningConfigured,
    severity: 'INFO',
    reason: facts.previewSigningConfigured
      ? 'Private previews can be minted for this version.'
      : 'No preview signing key is configured, so no private preview link can be minted.',
    action: facts.previewSigningConfigured
      ? 'Use venues.get_preview_link to review the exact version first.'
      : 'A person sets the server preview signing secret.',
  })
  if (facts.websiteDistribution !== null) {
    add({
      key: 'website_surface',
      passed: facts.websiteDistribution === 'ENABLED',
      severity: 'INFO',
      reason:
        facts.websiteDistribution === 'ENABLED'
          ? 'The website surface is enabled.'
          : 'The website surface is disabled; the public link still works when the venue is active.',
      action: 'Visitor access surfaces are changed by a person, not by a release.',
    })
  }
  return items
}

export function preflightReady(items: readonly PreflightPrerequisite[]): boolean {
  return items.every((item) => item.severity !== 'BLOCKER' || item.passed)
}
