import { z } from 'zod'

import type { TRPCContext } from '../context'
import { mediaIntakeHash } from './media-intake-snapshot'
import { reviewedMediaTemporalOperationalDraft } from './media-temporal-operational-draft'
import {
  mediaTemporalReceiptInput,
  validateMediaTemporalReviewSnapshot,
} from './media-temporal-review-receipt'

const boundedId = z.string().trim().min(1).max(191)
const normalizedUuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const timestamp = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())

export const KnowledgeProposalTemporalEvidenceReference = z
  .object({
    reviewReceiptId: normalizedUuid,
    expectedSnapshotHash: sha256,
    claimId: boundedId,
  })
  .strict()

export type KnowledgeProposalTemporalEvidenceReference = z.infer<
  typeof KnowledgeProposalTemporalEvidenceReference
>

export async function resolveKnowledgeProposalTemporalEvidence(input: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  reference: z.input<typeof KnowledgeProposalTemporalEvidenceReference>
  desiredTitle: string
  desiredCategory: string
  desiredContent: string
  validFrom: string
  validUntil: string
}) {
  const tenantId = boundedId.parse(input.tenantId)
  const venueId = boundedId.parse(input.venueId)
  const reference = KnowledgeProposalTemporalEvidenceReference.parse(input.reference)
  const desiredTitle = boundedId.parse(input.desiredTitle)
  const desiredCategory = boundedId.parse(input.desiredCategory)
  const validFrom = timestamp.parse(input.validFrom)
  const validUntil = timestamp.parse(input.validUntil)

  const receipt = await input.db.mediaTemporalReviewReceipt.findFirst({
    where: { id: reference.reviewReceiptId, tenantId, venueId },
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      snapshot: true,
      snapshotHash: true,
      requestHash: true,
      actorId: true,
      evaluatedAt: true,
    },
  })
  if (!receipt) throw new Error('The exact temporal review receipt is unavailable.')

  const snapshot = validateMediaTemporalReviewSnapshot(receipt.snapshot)
  if (
    receipt.id !== reference.reviewReceiptId ||
    receipt.tenantId !== tenantId ||
    receipt.venueId !== venueId ||
    snapshot.tenantId !== tenantId ||
    snapshot.venueId !== venueId ||
    snapshot.reviewedBy !== receipt.actorId ||
    snapshot.temporalReview.evaluatedAt !== receipt.evaluatedAt.toISOString() ||
    mediaIntakeHash(snapshot) !== receipt.snapshotHash ||
    receipt.snapshotHash !== reference.expectedSnapshotHash ||
    mediaIntakeHash({ input: mediaTemporalReceiptInput(snapshot), actorId: receipt.actorId }) !==
      receipt.requestHash
  ) {
    throw new Error('Temporal review receipt failed its scope or integrity check.')
  }

  const draft = reviewedMediaTemporalOperationalDraft({
    snapshot,
    expectedSnapshotHash: reference.expectedSnapshotHash,
    claimId: reference.claimId,
    now: new Date().toISOString(),
  })
  const target = snapshot.items.find((item) => item.binding.itemHash === draft.targetItemHash)
  const knowledge = target?.binding.kind === 'knowledge' ? target.value : null
  if (
    !knowledge ||
    typeof knowledge !== 'object' ||
    !('title' in knowledge) ||
    !('category' in knowledge) ||
    knowledge.title !== desiredTitle ||
    knowledge.category !== desiredCategory
  ) {
    throw new Error('The proposed knowledge identity does not match the reviewed target.')
  }

  const now = Date.now()
  const start = Date.parse(draft.startsAt)
  const end = Date.parse(draft.expiresAt)
  const peers = snapshot.temporalReview.claims.filter(
    (claim) => claim.targetKey === draft.targetKey,
  )
  const checkpoints = new Set([Math.max(start, now)])
  for (const peer of peers) {
    for (const bound of [peer.effectiveFrom, peer.effectiveUntil]) {
      const instant = bound ? Date.parse(bound) : NaN
      if (instant >= Math.max(start, now) && instant < end) checkpoints.add(instant)
    }
  }
  for (const instant of checkpoints) {
    const agreeingSources = new Set(
      peers
        .filter(
          (claim) =>
            claim.targetItemHash === draft.targetItemHash &&
            claim.value === draft.body &&
            claim.authority !== 'HISTORICAL_SOURCE' &&
            (!claim.effectiveFrom || Date.parse(claim.effectiveFrom) <= instant) &&
            (!claim.effectiveUntil || Date.parse(claim.effectiveUntil) > instant),
        )
        .map((claim) => claim.source.sourceSha256),
    )
    if (agreeingSources.size < 2) {
      throw new Error(
        'The reviewed temporal claim lacks two distinct agreeing sources throughout its remaining interval.',
      )
    }
  }
  if (
    draft.tenantId !== tenantId ||
    draft.venueId !== venueId ||
    draft.body !== input.desiredContent ||
    draft.startsAt !== validFrom ||
    draft.expiresAt !== validUntil
  ) {
    throw new Error('The proposed change does not match the exact reviewed temporal claim.')
  }

  const sourceRef = `media-temporal-receipt:${receipt.id}:snapshot:${receipt.snapshotHash}:claim:${draft.runSource.claimHash}`
  return {
    reference,
    claimHash: draft.runSource.claimHash,
    reviewedBy: receipt.actorId,
    reviewedAt: snapshot.temporalReview.evaluatedAt,
    sourceRef,
    targetKey: draft.targetKey,
    targetItemHash: draft.targetItemHash,
    authorityBasis: 'REVIEW_ASSERTED' as const,
    authorityVerified: false as const,
  }
}
