import { z } from 'zod'
import { db, createOperationalUpdateAction, writeAuditLogStrict } from '@pathfinder/db'
import { mediaIntakeHash } from './media-intake-snapshot'
import {
  mediaTemporalReceiptInput,
  validateMediaTemporalReviewSnapshot,
} from './media-temporal-review-receipt'
import { reviewedMediaTemporalOperationalDraft } from './media-temporal-operational-draft'

const id = z.string().trim().min(1).max(191)
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
export const MediaTemporalOperationalInput = z
  .object({
    tenantId: id,
    venueId: id,
    reviewReceiptId: uuid,
    requestId: uuid,
    claimId: id,
    expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    rationale: z.string().trim().min(1).max(2000),
    title: z.string().trim().min(1).max(255),
    updateType: z.enum([
      'GENERAL_NOTICE',
      'TEMPORARY_CLOSURE',
      'UNAVAILABLE_EXHIBIT',
      'CHANGED_HOURS',
      'MAINTENANCE',
      'SPECIAL_EVENT',
      'SOLD_OUT_ACTIVITY',
      'TEMPORARY_VENDOR_LOCATION',
    ]),
    severity: z.enum(['INFO', 'WARNING', 'CLOSURE', 'REDIRECT']),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  })
  .strict()
export class MediaTemporalOperationalError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'INVALID_REVIEW',
    message: string,
  ) {
    super(message)
    this.name = 'MediaTemporalOperationalError'
  }
}
const handoffSelect = {
  id: true,
  operationalUpdateId: true,
  actorId: true,
  requestHash: true,
  inputSnapshot: true,
} as const
type Handoff = {
  id: string
  operationalUpdateId: string
  actorId: string
  requestHash: string
  inputSnapshot: unknown
}
function replay(receipt: Handoff, requestHash: string, actorId: string) {
  const frozen = receipt.inputSnapshot as { input?: unknown; actorId?: unknown } | null
  const input = MediaTemporalOperationalInput.safeParse(frozen?.input)
  if (
    !input.success ||
    receipt.requestHash !== requestHash ||
    receipt.actorId !== actorId ||
    frozen?.actorId !== actorId ||
    receipt.operationalUpdateId !== input.data.requestId ||
    mediaIntakeHash({ input: input.data, actorId }) !== requestHash
  )
    throw new MediaTemporalOperationalError(
      'CONFLICT',
      'This dated draft request does not match its retained receipt.',
    )
  return {
    handoffId: receipt.id,
    operationalUpdateId: receipt.operationalUpdateId,
    createdAs: 'INACTIVE_DRAFT' as const,
    replayed: true,
  }
}

/** Existing operational-update action is the only writer. This handoff never schedules or publishes. */
export async function createMediaTemporalOperationalHandoff(params: {
  client: typeof db
  input: z.input<typeof MediaTemporalOperationalInput>
  actorId: string
}) {
  const input = MediaTemporalOperationalInput.parse(params.input)
  const actorId = id.parse(params.actorId)
  const requestHash = mediaIntakeHash({ input, actorId })
  const existing = await params.client.mediaTemporalOperationalHandoff.findFirst({
    where: { tenantId: input.tenantId, requestId: input.requestId },
    select: handoffSelect,
  })
  if (existing) return replay(existing, requestHash, actorId)
  const review = await params.client.mediaTemporalReviewReceipt.findFirst({
    where: { id: input.reviewReceiptId, tenantId: input.tenantId, venueId: input.venueId },
    select: { snapshot: true, snapshotHash: true, requestHash: true, actorId: true },
  })
  if (!review)
    throw new MediaTemporalOperationalError(
      'CONFLICT',
      'The exact temporal review receipt is unavailable.',
    )
  let snapshot: ReturnType<typeof validateMediaTemporalReviewSnapshot>
  try {
    snapshot = validateMediaTemporalReviewSnapshot(review.snapshot)
    if (
      snapshot.tenantId !== input.tenantId ||
      snapshot.venueId !== input.venueId ||
      snapshot.reviewedBy !== review.actorId ||
      mediaIntakeHash(snapshot) !== review.snapshotHash ||
      review.snapshotHash !== input.expectedSnapshotHash ||
      mediaIntakeHash({ input: mediaTemporalReceiptInput(snapshot), actorId: review.actorId }) !==
        review.requestHash
    )
      throw new Error('Temporal review receipt failed its scope or integrity check.')
  } catch (error) {
    throw new MediaTemporalOperationalError(
      'INVALID_REVIEW',
      error instanceof Error ? error.message : 'Invalid retained temporal evidence.',
    )
  }
  const derive = () => {
    try {
      return reviewedMediaTemporalOperationalDraft({
        snapshot,
        expectedSnapshotHash: input.expectedSnapshotHash,
        claimId: input.claimId,
        now: new Date().toISOString(),
      })
    } catch (error) {
      throw new MediaTemporalOperationalError(
        'INVALID_REVIEW',
        error instanceof Error ? error.message : 'The dated claim is not eligible for a draft.',
      )
    }
  }
  const draft = derive()
  let handoffId: string | null = null
  try {
    await createOperationalUpdateAction(
      {
        tenantId: input.tenantId,
        id: input.requestId,
        actor: { type: 'HUMAN', id: actorId, role: 'PLATFORM_ADMIN' },
        schedule: false,
        fields: {
          venueId: input.venueId,
          title: input.title,
          updateType: input.updateType,
          severity: input.severity,
          priority: input.priority,
          body: draft.body,
          startsAt: new Date(draft.startsAt),
          expiresAt: new Date(draft.expiresAt),
        },
        finalizer: async ({ tx, update }) => {
          const current = derive()
          if (
            update.tenantId !== input.tenantId ||
            update.venueId !== input.venueId ||
            update.status !== 'DRAFT' ||
            update.isActive ||
            update.body !== current.body ||
            update.startsAt.toISOString() !== current.startsAt ||
            update.expiresAt.toISOString() !== current.expiresAt ||
            update.title !== input.title ||
            update.updateType !== input.updateType ||
            update.severity !== input.severity ||
            update.priority !== input.priority
          )
            throw new MediaTemporalOperationalError(
              'CONFLICT',
              'The operational draft changed during evidence binding.',
            )
          const created = await tx.mediaTemporalOperationalHandoff.create({
            data: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              reviewReceiptId: input.reviewReceiptId,
              claimId: input.claimId,
              requestId: input.requestId,
              requestHash,
              operationalUpdateId: update.id,
              actorId,
              inputSnapshot: {
                input,
                actorId,
                claimHash: current.runSource.claimHash,
                reviewSnapshotHash: input.expectedSnapshotHash,
                draft: current,
              },
            },
            select: { id: true },
          })
          handoffId = created.id
          await writeAuditLogStrict(
            {
              tenantId: input.tenantId,
              actorId,
              actorRole: 'PLATFORM_ADMIN',
              action: 'media.temporal-review.operational-draft-created',
              targetType: 'OperationalUpdate',
              targetId: update.id,
              idempotencyKey: input.requestId,
              afterState: {
                reviewReceiptId: input.reviewReceiptId,
                claimId: input.claimId,
                snapshotHash: input.expectedSnapshotHash,
                status: 'DRAFT',
                isActive: false,
                rationale: input.rationale,
              },
            },
            tx,
          )
        },
      },
      params.client,
    )
    if (!handoffId) throw new Error('The dated draft handoff receipt was not retained.')
    return {
      handoffId,
      operationalUpdateId: input.requestId,
      createdAs: 'INACTIVE_DRAFT' as const,
      replayed: false,
    }
  } catch (error) {
    const retained = await params.client.mediaTemporalOperationalHandoff.findFirst({
      where: { tenantId: input.tenantId, requestId: input.requestId },
      select: handoffSelect,
    })
    if (retained) return replay(retained, requestHash, actorId)
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
      throw new MediaTemporalOperationalError(
        'CONFLICT',
        'This reviewed claim already has a dated draft, or the request identity is already used.',
      )
    throw error
  }
}
