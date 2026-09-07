import { createHash } from 'node:crypto'
import { z } from 'zod'
import { db, askAgentQuestionAction } from '@pathfinder/db'
import { buildReviewedMediaIntakeCandidate } from './media-intake-candidate'
import { mediaIntakeHash, validateMediaIntakeSnapshot } from './media-intake-snapshot'
import { mediaTemporalHolds, reconcileMediaTemporalClaims } from './media-temporal-reconciliation'
import {
  mediaTemporalReceiptInput,
  validateMediaTemporalReviewSnapshot,
} from './media-temporal-review-receipt'

const id = z.string().min(1).max(191)
export const MediaTemporalClarificationInput = z
  .object({
    tenantId: id,
    venueId: id,
    runId: id,
    agentIdentityId: id,
    targetKey: z.string().min(1).max(500),
    expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()

export class MediaTemporalClarificationError extends Error {}

export const MediaTemporalReceiptClarificationInput = z
  .object({
    tenantId: id,
    venueId: id,
    receiptId: z.string().uuid(),
    agentIdentityId: id,
    targetKey: z.string().min(1).max(500),
    expectedRequestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()

async function requireDraftIdentity(
  client: typeof db,
  input: { tenantId: string; venueId: string; agentIdentityId: string },
) {
  const identity = await client.agentIdentity.findFirst({
    where: {
      id: input.agentIdentityId,
      tenantId: input.tenantId,
      enabled: true,
      agentType: 'CONTENT',
      accessCapabilities: { has: 'content.draft' },
      OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
    },
    select: { id: true },
  })
  if (!identity)
    throw new MediaTemporalClarificationError(
      'An enabled in-scope Content identity with draft capability is required.',
    )
  return identity
}

function deterministicOperationId(namespace: string, input: unknown) {
  const operationBytes = createHash('sha256')
    .update(JSON.stringify([namespace, input]))
    .digest()
    .subarray(0, 16)
  operationBytes[6] = (operationBytes[6]! & 0x0f) | 0x50
  operationBytes[8] = (operationBytes[8]! & 0x3f) | 0x80
  const hex = operationBytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Creates one local question from a compact immutable temporal review receipt. */
export async function createMediaTemporalReceiptClarification(params: {
  client: typeof db
  actorId: string
  input: z.input<typeof MediaTemporalReceiptClarificationInput>
}) {
  const input = MediaTemporalReceiptClarificationInput.parse(params.input)
  const actorId = id.parse(params.actorId)
  const receipt = await params.client.mediaTemporalReviewReceipt.findFirst({
    where: { id: input.receiptId, tenantId: input.tenantId, venueId: input.venueId },
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      projectId: true,
      sourceGeneration: true,
      uploadAttemptId: true,
      requestId: true,
      requestHash: true,
      snapshotHash: true,
      snapshot: true,
      actorId: true,
    },
  })
  if (!receipt) throw new MediaTemporalClarificationError('Temporal review receipt not found.')
  let snapshot: ReturnType<typeof validateMediaTemporalReviewSnapshot>
  try {
    snapshot = validateMediaTemporalReviewSnapshot(receipt.snapshot)
  } catch {
    throw new MediaTemporalClarificationError(
      'The retained temporal review failed its integrity check.',
    )
  }
  if (
    receipt.requestHash !== input.expectedRequestHash ||
    receipt.snapshotHash !== input.expectedSnapshotHash ||
    mediaIntakeHash(snapshot) !== receipt.snapshotHash ||
    snapshot.tenantId !== receipt.tenantId ||
    snapshot.venueId !== receipt.venueId ||
    snapshot.projectId !== receipt.projectId ||
    snapshot.sourceGeneration !== receipt.sourceGeneration.toLowerCase() ||
    snapshot.uploadAttemptId !== receipt.uploadAttemptId ||
    snapshot.requestId !== receipt.requestId.toLowerCase() ||
    snapshot.reviewedBy !== receipt.actorId ||
    mediaIntakeHash({ input: mediaTemporalReceiptInput(snapshot), actorId: receipt.actorId }) !==
      receipt.requestHash
  )
    throw new MediaTemporalClarificationError(
      'The temporal receipt does not match its exact scope, reviewer, or submission.',
    )

  const held = new Set(
    mediaTemporalHolds(snapshot.temporalReview.claims, snapshot.temporalReview.evaluatedAt).map(
      (entry) => entry.itemHash,
    ),
  )
  const claims = snapshot.temporalReview.claims.filter(
    (claim) => claim.targetKey === input.targetKey && held.has(claim.targetItemHash),
  )
  if (!claims.length)
    throw new MediaTemporalClarificationError('Choose a retained target with a local hold.')
  const identity = await requireDraftIdentity(params.client, input)
  const result = await askAgentQuestionAction(
    {
      operationId: deterministicOperationId('media-temporal-receipt-clarification:v1', {
        ...input,
        actorId,
      }),
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentIdentityId: identity.id,
      question: `For ${input.targetKey}, what is the current correct information, who confirms it, and when does it take effect and end?`,
      context:
        'This question concerns one held item in an immutable temporal review receipt. Unrelated items may continue. Answering does not modify a source, approve content, or publish anything.',
      questionType: 'LONG_TEXT',
      category: 'media-temporal-clarification',
      urgency: 'NORMAL',
      evidence: claims.slice(0, 10).map((claim) => ({
        kind: 'DOCUMENT_EXCERPT' as const,
        label: `${claim.claimId}: ${claim.authority}`.slice(0, 200),
        reference: `media-temporal-receipt:${receipt.id}:snapshot:${receipt.snapshotHash}:claim:${mediaIntakeHash(claim)}`,
        summary: `${claim.value.slice(0, 750)}\nEffective from: ${claim.effectiveFrom ?? 'unknown'}; until: ${claim.effectiveUntil ?? 'unknown'}.`,
      })),
      callbackMetadata: {
        workflow: 'media-temporal-receipt-clarification',
        receiptId: receipt.id,
        requestHash: receipt.requestHash,
        snapshotHash: receipt.snapshotHash,
        reconciliationHash: snapshot.temporalReview.reconciliationHash,
        targetKey: input.targetKey,
        targetItemSetHash: mediaIntakeHash(
          [...new Set(claims.map((claim) => claim.targetItemHash))].sort(),
        ),
        blockerScope: 'LOCAL',
        sourceAmendmentRequired: true,
        claimCount: claims.length,
        displayedClaimCount: Math.min(claims.length, 10),
      },
      blocking: false,
    },
    params.client,
  )
  return {
    questionId: result.question.id,
    replayed: result.replayed,
    receiptId: receipt.id,
    blockerScope: 'LOCAL' as const,
    sourceAmendmentRequired: true,
    publicationTriggered: false,
    canonicalVenueChanged: false,
  }
}

/** Internal, local question only. An answer never changes the frozen handoff or publishes content. */
export async function createMediaTemporalClarification(params: {
  client: typeof db
  input: z.input<typeof MediaTemporalClarificationInput>
}) {
  const input = MediaTemporalClarificationInput.parse(params.input)
  const run = await params.client.intakeRun.findFirst({
    where: {
      id: input.runId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      structuredBootstrap: { path: ['kind'], equals: 'MEDIA_PROJECT_REVIEW' },
    },
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      requestedBy: true,
      requestedByType: true,
      submissionRequestId: true,
      submissionInputHash: true,
      structuredBootstrap: true,
      evidence: {
        select: { locator: true, normalizedHash: true, sourceKind: true, confidence: true },
      },
    },
  })
  if (!run) throw new MediaTemporalClarificationError('Reviewed media handoff not found.')
  let snapshot: ReturnType<typeof validateMediaIntakeSnapshot>
  try {
    buildReviewedMediaIntakeCandidate(run)
    snapshot = validateMediaIntakeSnapshot(run.structuredBootstrap)
  } catch {
    throw new MediaTemporalClarificationError(
      'The retained media handoff failed its integrity check.',
    )
  }
  if (mediaIntakeHash(snapshot) !== input.expectedSnapshotHash || !snapshot.temporalReview)
    throw new MediaTemporalClarificationError('The exact retained temporal review is unavailable.')
  const review = snapshot.temporalReview
  const reconciliation = reconcileMediaTemporalClaims({
    claims: review.claims,
    now: review.evaluatedAt,
  })
  const comparison = reconciliation.comparisons.find((entry) => entry.targetKey === input.targetKey)
  const claims = review.claims.filter((claim) => claim.targetKey === input.targetKey)
  const held = new Set(
    mediaTemporalHolds(review.claims, review.evaluatedAt).map((entry) => entry.itemHash),
  )
  if (!comparison || !claims.length || !claims.some((claim) => held.has(claim.targetItemHash)))
    throw new MediaTemporalClarificationError('Choose a retained target with a local hold.')
  const identity = await requireDraftIdentity(params.client, input)
  const operationId = deterministicOperationId('media-temporal-clarification:v1', input)
  const result = await askAgentQuestionAction(
    {
      operationId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentIdentityId: identity.id,
      question: `For ${input.targetKey}, what is the current correct information, who confirms it, and when does it take effect and end?`,
      context:
        'This question concerns one held media item. Unrelated reviewed items may continue. The evidence and authority labels are review assertions. Incorporate the answer through a new reviewed source amendment or dated operational-update draft; answering does not modify this frozen handoff or approve publication.',
      questionType: 'LONG_TEXT',
      category: 'media-temporal-clarification',
      urgency: 'NORMAL',
      evidence: claims.slice(0, 10).map((claim) => ({
        kind: 'DOCUMENT_EXCERPT' as const,
        label: `${claim.claimId}: ${claim.authority}`.slice(0, 200),
        reference: `media-temporal:${input.runId}:snapshot:${input.expectedSnapshotHash}:claim:${mediaIntakeHash(claim)}`,
        summary: `${claim.value.slice(0, 750)}\nEffective from: ${claim.effectiveFrom ?? 'unknown'}; until: ${claim.effectiveUntil ?? 'unknown'}.`,
      })),
      callbackMetadata: {
        workflow: 'media-temporal-clarification',
        runId: input.runId,
        snapshotHash: input.expectedSnapshotHash,
        reconciliationHash: review.reconciliationHash,
        targetKey: input.targetKey,
        targetItemSetHash: mediaIntakeHash(
          [...new Set(claims.map((claim) => claim.targetItemHash))].sort(),
        ),
        blockerScope: 'LOCAL',
        sourceAmendmentRequired: true,
        claimCount: claims.length,
        displayedClaimCount: Math.min(claims.length, 10),
      },
      blocking: false,
    },
    params.client,
  )
  return {
    questionId: result.question.id,
    replayed: result.replayed,
    blockerScope: 'LOCAL' as const,
    sourceAmendmentRequired: true,
    publicationTriggered: false,
    canonicalVenueChanged: false,
  }
}
