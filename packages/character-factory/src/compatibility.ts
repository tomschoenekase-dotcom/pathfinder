import { createHash } from 'node:crypto'
import {
  FACTORY_STATES,
  type CharacterSpec,
  type CompatibilityFinding,
  type CompatibilityReport,
} from './types'
import { resolveRig } from './rigs'

const ACTIVE_SVG =
  /<(?:script|foreignObject|iframe|audio|video)\b|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|data:|javascript:)/i

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function inspectImportedSkin(spec: CharacterSpec, svg: string): CompatibilityReport {
  const findings: CompatibilityFinding[] = []
  const rig = resolveRig(spec)
  if (!rig)
    return {
      fixtureId: spec.characterId,
      compatible: false,
      rigFamily: spec.rigFamily,
      stateCoverage: [],
      unsuitableStates: FACTORY_STATES,
      requiredManualCleanup: [],
      findings: [
        {
          code: 'INVALID_RIG_CAPABILITIES',
          severity: 'error',
          detail: 'Custom rig capabilities are missing, mismatched, or outside safe bounds.',
        },
      ],
    }
  const missingSlots = rig.requiredSlots.filter((slot) => !spec.slotMap[slot])
  if (!/^\s*<svg\b/i.test(svg) || !/viewBox=["']0 0 72 72["']/i.test(svg)) {
    findings.push({
      code: 'UNSUPPORTED_CANVAS',
      severity: 'error',
      detail: 'Fixture must be a normalized 72×72 SVG source.',
    })
  }
  if (ACTIVE_SVG.test(svg)) {
    findings.push({
      code: 'ACTIVE_SVG_REJECTED',
      severity: 'error',
      detail: 'Active or remotely loaded SVG content cannot enter a trusted rig.',
    })
  }
  if (sha256(svg) !== spec.source.sha256 || Buffer.byteLength(svg) !== spec.source.byteLength) {
    findings.push({
      code: 'SOURCE_INTEGRITY_MISMATCH',
      severity: 'error',
      detail: 'Imported bytes do not match recorded provenance.',
    })
  }
  if (missingSlots.length > 0) {
    findings.push({
      code: 'MISSING_RIG_SLOTS',
      severity: 'error',
      detail: `Missing slots: ${missingSlots.join(', ')}`,
    })
  }
  if (
    spec.protectedTraits.length === 0 ||
    spec.protectedTraits.some((trait) => trait.trim().length < 3)
  ) {
    findings.push({
      code: 'IDENTITY_TRAITS_REQUIRED',
      severity: 'error',
      detail: 'Imported candidates need explicit, non-empty protected identity traits.',
    })
  }
  if (!spec.masterReference || spec.source.kind !== 'imported') {
    findings.push({
      code: 'IMPORT_PROVENANCE_REQUIRED',
      severity: 'error',
      detail: 'A canonical master reference and imported provenance are required.',
    })
  }
  const unsupported = FACTORY_STATES.filter((state) => !spec.supportedStates.includes(state))
  if (unsupported.length > 0) {
    findings.push({
      code: 'PARTIAL_STATE_COVERAGE',
      severity: 'warning',
      detail: `Unsupported states: ${unsupported.join(', ')}`,
    })
  }
  const cleanup =
    spec.rigFamily === 'morph-v1'
      ? ['separate face from deforming body mask']
      : spec.rigFamily === 'compact-creature-v1'
        ? ['separate paired wings and eyes from body']
        : spec.rigFamily === 'humanoid-v1'
          ? ['separate arms, helmet/head, and torso; define shoulder pivots']
          : [`prepare declared ${spec.rigCapabilities?.anatomyClass ?? 'custom'} slots and pivots`]
  findings.push({
    code: 'SOURCE_ONLY_NOT_RUNTIME_SAFE',
    severity: 'info',
    detail:
      'The imported SVG remains quarantined source; production slots must be normalized raster assets.',
  })
  return {
    fixtureId: spec.characterId,
    compatible: findings.every((finding) => finding.severity !== 'error'),
    rigFamily: spec.rigFamily,
    stateCoverage: spec.supportedStates,
    unsuitableStates: unsupported,
    requiredManualCleanup: cleanup,
    findings,
  }
}
