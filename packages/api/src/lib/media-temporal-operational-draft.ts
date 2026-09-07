import { z } from 'zod'
import { validateMediaIntakeSnapshot, mediaIntakeHash } from './media-intake-snapshot'
import { reconcileMediaTemporalClaims } from './media-temporal-reconciliation'
import { validateMediaTemporalReviewSnapshot } from './media-temporal-review-receipt'

/** Derives a dated draft only when the same reviewed claim controls throughout its remaining interval. */
export function reviewedMediaTemporalOperationalDraft(params: {
  snapshot: unknown
  expectedSnapshotHash: string
  claimId: string
  now: string
}) {
  const snapshot =
    params.snapshot &&
    typeof params.snapshot === 'object' &&
    'kind' in params.snapshot &&
    params.snapshot.kind === 'MEDIA_TEMPORAL_REVIEW'
      ? validateMediaTemporalReviewSnapshot(params.snapshot)
      : validateMediaIntakeSnapshot(params.snapshot)
  const now = Date.parse(z.string().datetime({ offset: true }).parse(params.now))
  if (mediaIntakeHash(snapshot) !== params.expectedSnapshotHash || !snapshot.temporalReview)
    throw new Error('The exact frozen temporal review is required.')
  const claim = snapshot.temporalReview.claims.find((entry) => entry.claimId === params.claimId)
  if (!claim?.effectiveFrom || !claim.effectiveUntil)
    throw new Error('A dated update requires an explicit finite start and end.')
  const start = Date.parse(claim.effectiveFrom)
  const end = Date.parse(claim.effectiveUntil)
  if (end <= now) throw new Error('An expired claim cannot create a current operational draft.')
  const peers = snapshot.temporalReview.claims.filter(
    (entry) => entry.targetKey === claim.targetKey,
  )
  const checkpoints = new Set([Math.max(start, now)])
  for (const peer of peers) {
    for (const bound of [peer.effectiveFrom, peer.effectiveUntil]) {
      const value = bound ? Date.parse(bound) : NaN
      if (value >= Math.max(start, now) && value < end) checkpoints.add(value)
    }
  }
  for (const instant of checkpoints) {
    const review = reconcileMediaTemporalClaims({
      claims: peers,
      now: new Date(instant).toISOString(),
    })
    const comparison = review.comparisons[0]
    if (
      !comparison ||
      !['RECOMMENDED_AUTHORITY', 'RECOMMENDED_CORROBORATED'].includes(comparison.disposition) ||
      !review.selectedClaimIds.includes(claim.claimId)
    )
      throw new Error(
        'Resolve competing or unverified claims throughout this schedule before creating its dated draft.',
      )
  }
  return {
    runSource: {
      projectId: snapshot.projectId,
      sourceGeneration: snapshot.sourceGeneration,
      snapshotHash: params.expectedSnapshotHash,
      claimId: claim.claimId,
      claimHash: mediaIntakeHash(claim),
    },
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    targetKey: claim.targetKey,
    targetItemHash: claim.targetItemHash,
    body: claim.value,
    startsAt: new Date(start).toISOString(),
    expiresAt: new Date(end).toISOString(),
    status: 'DRAFT' as const,
    isActive: false as const,
    authorityBasis: 'REVIEW_ASSERTED' as const,
    authorityVerified: false as const,
  }
}
