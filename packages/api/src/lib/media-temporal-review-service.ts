import { z } from 'zod'
import { db, writeAuditLogStrict } from '@pathfinder/db'
import { captureMediaTemporalReview } from './media-temporal-review-capture'
import { mediaIntakeHash } from './media-intake-snapshot'
import { mediaTemporalHolds } from './media-temporal-reconciliation'
import {
  MediaTemporalReceiptInput,
  mediaTemporalReceiptInput,
  validateMediaTemporalReviewSnapshot,
  MEDIA_TEMPORAL_RECEIPT_MAX_BYTES,
} from './media-temporal-review-receipt'

export class MediaTemporalReceiptError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'INVALID_REVIEW',
    message: string,
  ) {
    super(message)
    this.name = 'MediaTemporalReceiptError'
  }
}
type Client = Pick<typeof db, '$transaction' | 'mediaTemporalReviewReceipt'>
const select = {
  id: true,
  actorId: true,
  requestHash: true,
  snapshotHash: true,
  snapshot: true,
} as const
type Receipt = {
  id: string
  actorId: string
  requestHash: string
  snapshotHash: string
  snapshot: unknown
}
function outcome(receipt: Receipt, inputHash: string, actorId: string, replayed: boolean) {
  if (receipt.requestHash !== inputHash || receipt.actorId !== actorId)
    throw new MediaTemporalReceiptError(
      'CONFLICT',
      'This temporal review request belongs to different input or a different reviewer.',
    )
  let snapshot: ReturnType<typeof validateMediaTemporalReviewSnapshot>
  try {
    snapshot = validateMediaTemporalReviewSnapshot(receipt.snapshot)
  } catch {
    throw new MediaTemporalReceiptError(
      'CONFLICT',
      'The retained temporal evidence failed its integrity check.',
    )
  }
  if (
    mediaIntakeHash(snapshot) !== receipt.snapshotHash ||
    snapshot.reviewedBy !== actorId ||
    mediaIntakeHash({ input: mediaTemporalReceiptInput(snapshot), actorId }) !== inputHash
  )
    throw new MediaTemporalReceiptError(
      'CONFLICT',
      'The retained temporal receipt does not match its exact submission.',
    )
  return {
    receiptId: receipt.id,
    snapshotHash: receipt.snapshotHash,
    heldItems: mediaTemporalHolds(
      snapshot.temporalReview.claims,
      snapshot.temporalReview.evaluatedAt,
    ),
    evaluatedAt: snapshot.temporalReview.evaluatedAt,
    replayed,
    builderRunCreated: false as const,
    publicationTriggered: false as const,
  }
}

/** Caller establishes platform-human authority. Review may retain only held items; no Builder run is created. */
export async function createMediaTemporalReviewReceipt(params: {
  client: Client
  input: z.input<typeof MediaTemporalReceiptInput>
  actorId: string
}) {
  const input = MediaTemporalReceiptInput.parse(params.input)
  const actorId = z.string().trim().min(1).max(191).parse(params.actorId)
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MEDIA_TEMPORAL_RECEIPT_MAX_BYTES)
    throw new MediaTemporalReceiptError(
      'INVALID_REVIEW',
      'Temporal review input exceeds its limit.',
    )
  const requestHash = mediaIntakeHash({ input, actorId })
  try {
    return await params.client.$transaction(
      async (rawTx) => {
        const tx = rawTx as unknown as typeof db
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['media-temporal-review', input.tenantId, input.requestId])}, 0))`
        const existing = await tx.mediaTemporalReviewReceipt.findFirst({
          where: { tenantId: input.tenantId, requestId: input.requestId },
          select,
        })
        if (existing) return outcome(existing, requestHash, actorId, true)
        const projects = await tx.$queryRaw<
          Array<{
            updatedAt: Date
            uploadAttemptId: string | null
            sourceObjectKey: string | null
            draft: unknown
            findings: unknown
          }>
        >`
        SELECT updated_at AS "updatedAt", upload_attempt_id AS "uploadAttemptId", source_object_key AS "sourceObjectKey",
          CASE WHEN octet_length(draft_json::text) <= 8388608 THEN draft_json ELSE NULL END AS draft,
          CASE WHEN octet_length(findings::text) <= 8388608 THEN findings ELSE NULL END AS findings
        FROM media_ingestion_projects WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
          AND id = ${input.projectId} AND source_object_generation = ${input.sourceGeneration}::uuid
          AND status = 'READY_FOR_REVIEW' AND stage = 'review' FOR UPDATE
      `
        const project = projects[0]
        if (
          !project?.uploadAttemptId ||
          !project.sourceObjectKey ||
          !project.draft ||
          !project.findings ||
          project.updatedAt.toISOString() !== input.expectedUpdatedAt
        )
          throw new MediaTemporalReceiptError(
            'CONFLICT',
            'The exact current media review is unavailable, changed, or exceeds its evidence limit.',
          )
        const sourceIds = [...new Set(input.claims.map((claim) => claim.source.sourceId))]
        await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM media_ingestion_assets WHERE tenant_id = ${input.tenantId}
          AND project_id = ${input.projectId} AND source_id = ANY(${sourceIds}::text[]) FOR SHARE
      `
        const assets = await tx.mediaIngestionAsset.findMany({
          where: {
            tenantId: input.tenantId,
            projectId: input.projectId,
            sourceId: { in: sourceIds },
            objectKey: { startsWith: `${project.sourceObjectKey}#` },
          },
          select: {
            id: true,
            sourceId: true,
            sha256: true,
            status: true,
            mediaType: true,
            filename: true,
          },
          take: 101,
        })
        let snapshot: ReturnType<typeof captureMediaTemporalReview>
        try {
          snapshot = captureMediaTemporalReview({
            input,
            actorId,
            uploadAttemptId: project.uploadAttemptId,
            draft: project.draft,
            findings: project.findings,
            assets,
            evaluatedAt: new Date().toISOString(),
          })
        } catch (error) {
          throw new MediaTemporalReceiptError(
            'INVALID_REVIEW',
            error instanceof Error ? error.message : 'Invalid temporal evidence.',
          )
        }
        const snapshotHash = mediaIntakeHash(snapshot)
        const receipt = await tx.mediaTemporalReviewReceipt.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            projectId: input.projectId,
            sourceGeneration: input.sourceGeneration,
            uploadAttemptId: project.uploadAttemptId,
            requestId: input.requestId,
            requestHash,
            snapshotHash,
            snapshot,
            actorId,
            evaluatedAt: new Date(snapshot.temporalReview.evaluatedAt),
          },
          select,
        })
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId,
            actorRole: 'PLATFORM_ADMIN',
            action: 'media.temporal-review.retained',
            targetType: 'MediaTemporalReviewReceipt',
            targetId: receipt.id,
            idempotencyKey: input.requestId,
            afterState: {
              snapshotHash,
              projectId: input.projectId,
              sourceGeneration: input.sourceGeneration,
              claimCount: input.claims.length,
              itemCount: input.bindings.length,
              builderRunCreated: false,
              publicationTriggered: false,
            },
          },
          tx,
        )
        return outcome(receipt, requestHash, actorId, false)
      },
      { isolationLevel: 'Serializable' },
    )
  } catch (error) {
    const existing = await params.client.mediaTemporalReviewReceipt.findFirst({
      where: { tenantId: input.tenantId, requestId: input.requestId },
      select,
    })
    if (existing) return outcome(existing, requestHash, actorId, true)
    throw error
  }
}
