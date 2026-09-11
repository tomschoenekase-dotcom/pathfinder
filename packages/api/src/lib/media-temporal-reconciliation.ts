import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  MediaTemporalClaimSchema,
  type MediaTemporalClaim,
} from '@pathfinder/contracts/media-temporal-claims'

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
const activeAt = (claim: MediaTemporalClaim, now: number) =>
  (!claim.effectiveFrom || Date.parse(claim.effectiveFrom) <= now) &&
  (!claim.effectiveUntil || Date.parse(claim.effectiveUntil) > now)

/** Holds apply to individual source-bound items; date-bound facts need the dated update path. */
export function mediaTemporalHolds(claims: MediaTemporalClaim[], now: string) {
  const reconciliation = reconcileMediaTemporalClaims({ claims, now })
  const blockedTargets = new Set(reconciliation.blockedTargetKeys)
  const historicalTargets = new Set(
    reconciliation.comparisons
      .filter((entry) => entry.disposition === 'HISTORICAL_ONLY')
      .map((entry) => entry.targetKey),
  )
  type Reason = 'CONFLICT' | 'DATE_BOUND' | 'NO_CURRENT_SUPPORT'
  const held = new Map<string, Set<Reason>>()
  for (const claim of claims) {
    const reasons = held.get(claim.targetItemHash) ?? new Set<Reason>()
    if (blockedTargets.has(claim.targetKey)) reasons.add('CONFLICT')
    if (historicalTargets.has(claim.targetKey)) reasons.add('NO_CURRENT_SUPPORT')
    if (claim.claimType === 'TEMPORARY_SCHEDULE' || claim.effectiveFrom || claim.effectiveUntil)
      reasons.add('DATE_BOUND')
    if (reasons.size) held.set(claim.targetItemHash, reasons)
  }
  return [...held]
    .sort(([a], [b]) => compare(a, b))
    .map(([itemHash, reasons]) => ({ itemHash, reasons: [...reasons].sort() }))
}

type Disposition =
  | 'TARGET_INCONSISTENT'
  | 'FUTURE_SCHEDULE'
  | 'EXPIRED_SCHEDULE'
  | 'HISTORICAL_ONLY'
  | 'RECOMMENDED_AUTHORITY'
  | 'RECOMMENDED_CORROBORATED'
  | 'UNVERIFIED_SINGLE'
  | 'DEFERRED_NON_CONSEQUENTIAL'
  | 'BLOCKED'
type ComparisonEvidence = MediaTemporalClaim['source'] & {
  claimId: string
  authority: MediaTemporalClaim['authority']
  effectiveFrom: string | null
  effectiveUntil: string | null
  value: string
  valueHash: string
}

export function reconcileMediaTemporalClaims(input: { claims: unknown[]; now: string }) {
  const now = z.string().datetime({ offset: true }).parse(input.now)
  const nowMs = Date.parse(now)
  const claims = z
    .array(MediaTemporalClaimSchema)
    .min(1)
    .max(2_000)
    .parse(input.claims)
    .sort((a, b) => compare(a.targetKey, b.targetKey) || compare(a.claimId, b.claimId))
  if (new Set(claims.map((claim) => claim.claimId)).size !== claims.length)
    throw new Error('Temporal claim IDs must be unique.')
  for (const claim of claims)
    if (claim.valueHash !== createHash('sha256').update(claim.value).digest('hex'))
      throw new Error(`Temporal claim ${claim.claimId} value hash does not match its exact value.`)
  const claimTemporalDispositions = claims.map((claim) => ({
    claimId: claim.claimId,
    disposition:
      !claim.effectiveFrom && !claim.effectiveUntil
        ? ('ACTIVE' as const)
        : claim.effectiveFrom && Date.parse(claim.effectiveFrom) > nowMs
          ? ('FUTURE' as const)
          : claim.effectiveUntil && Date.parse(claim.effectiveUntil) <= nowMs
            ? ('EXPIRED' as const)
            : ('ACTIVE' as const),
  }))
  const groups = new Map<string, MediaTemporalClaim[]>()
  for (const claim of claims)
    groups.set(claim.targetKey, [...(groups.get(claim.targetKey) ?? []), claim])
  const selectedClaimIds: string[] = []
  const blockedTargetKeys: string[] = []
  const comparisons: Array<{
    targetKey: string
    disposition: Disposition
    claimIds: string[]
    evidence: ComparisonEvidence[]
    recommendation: string
  }> = []
  for (const [targetKey, group] of groups) {
    const active = group.filter((claim) => activeAt(claim, nowMs))
    const authorized = active.filter((claim) => claim.authority === 'AUTHORIZED_STAFF')
    const authorityValues = new Set(authorized.map((claim) => claim.valueHash))
    const activeValues = new Set(active.map((claim) => claim.valueHash))
    let disposition: Disposition
    let recommendation: string
    if (new Set(group.map((claim) => claim.targetItemHash)).size > 1) {
      disposition = 'TARGET_INCONSISTENT'
      blockedTargetKeys.push(targetKey)
      recommendation =
        'Correct the conflicting target item identity before reconciling these claims.'
    } else if (!active.length) {
      const temporary = group.filter((claim) => claim.claimType === 'TEMPORARY_SCHEDULE')
      disposition = temporary.some((claim) => Date.parse(claim.effectiveFrom!) > nowMs)
        ? 'FUTURE_SCHEDULE'
        : temporary.length
          ? 'EXPIRED_SCHEDULE'
          : 'HISTORICAL_ONLY'
      recommendation =
        disposition === 'FUTURE_SCHEDULE'
          ? 'Retain this finite schedule for later reviewed activation; publish no current claim.'
          : 'Retain the dated evidence as history; publish no current claim.'
    } else if (authorityValues.size === 1 && authorized.length) {
      selectedClaimIds.push(...authorized.map((claim) => claim.claimId))
      disposition = 'RECOMMENDED_AUTHORITY'
      recommendation =
        'Use the active authorized-staff claim only as a review recommendation within its stated interval; retain conflicting lower-authority evidence.'
    } else if (activeValues.size === 1) {
      selectedClaimIds.push(...active.map((claim) => claim.claimId))
      const distinctSources = new Set(active.map((claim) => claim.source.sourceSha256)).size
      disposition = distinctSources > 1 ? 'RECOMMENDED_CORROBORATED' : 'UNVERIFIED_SINGLE'
      recommendation =
        distinctSources > 1
          ? 'The active sources agree; retain this as a review recommendation within the stated interval.'
          : 'One active non-authoritative source supports this claim; keep it unverified until human review.'
    } else if (!active.some((claim) => claim.consequential)) {
      disposition = 'DEFERRED_NON_CONSEQUENTIAL'
      recommendation =
        'Continue unrelated work and defer this non-consequential difference for later review.'
    } else {
      disposition = 'BLOCKED'
      blockedTargetKeys.push(targetKey)
      recommendation =
        authorityValues.size > 1
          ? 'Ask an authorized reviewer which current value controls.'
          : 'Ask a focused reviewer to resolve the current consequential difference.'
    }
    comparisons.push({
      targetKey,
      disposition,
      claimIds: group.map((claim) => claim.claimId),
      evidence: group.map((claim) => ({
        claimId: claim.claimId,
        authority: claim.authority,
        sourceId: claim.source.sourceId,
        sourceSha256: claim.source.sourceSha256,
        sourceVersion: claim.source.sourceVersion,
        capturedAt: claim.source.capturedAt,
        observationIndex: claim.source.observationIndex,
        observationSha256: claim.source.observationSha256,
        effectiveFrom: claim.effectiveFrom ?? null,
        effectiveUntil: claim.effectiveUntil ?? null,
        value: claim.value,
        valueHash: claim.valueHash,
      })),
      recommendation,
    })
  }
  const result = {
    now,
    selectedClaimIds: [...new Set(selectedClaimIds)].sort(compare),
    blockedTargetKeys: blockedTargetKeys.sort(compare),
    claimTemporalDispositions,
    comparisons,
  }
  return { ...result, reconciliationHash: hash({ claims, now, result }) }
}
