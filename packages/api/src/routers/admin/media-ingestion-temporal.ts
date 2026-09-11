import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { assertVenueAvailable, db, withTenantIsolationBypass } from '@pathfinder/db'

import {
  MediaTemporalReviewError,
  MediaTemporalReviewInput,
  previewMediaTemporalReview,
} from '../../lib/media-temporal-review'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  createMediaTemporalReviewReceipt,
  MediaTemporalReceiptError,
} from '../../lib/media-temporal-review-service'
import {
  MediaTemporalReceiptInput,
  mediaTemporalReceiptInput,
  validateMediaTemporalReviewSnapshot,
} from '../../lib/media-temporal-review-receipt'
import { mediaIntakeHash } from '../../lib/media-intake-snapshot'
import {
  createMediaTemporalOperationalHandoff,
  MediaTemporalOperationalError,
  MediaTemporalOperationalInput,
} from '../../lib/media-temporal-operational-service'
import {
  createMediaTemporalClarification,
  createMediaTemporalReceiptClarification,
  MediaTemporalReceiptClarificationInput,
  MediaTemporalClarificationError,
  MediaTemporalClarificationInput,
} from '../../lib/media-temporal-clarification'

export const mediaIngestionTemporalRouter = router({
  createTemporalReceiptClarification: adminProcedure
    .input(MediaTemporalReceiptClarificationInput)
    .mutation(({ input, ctx }) =>
      withTenantIsolationBypass(async () => {
        await assertVenueAvailable(db, { tenantId: input.tenantId, venueId: input.venueId })
        try {
          return await createMediaTemporalReceiptClarification({
            client: db,
            input,
            actorId: ctx.session.userId,
          })
        } catch (error) {
          if (error instanceof MediaTemporalClarificationError)
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: error.message,
              cause: error,
            })
          throw error
        }
      }),
    ),
  createTemporalOperationalDraft: adminProcedure
    .input(MediaTemporalOperationalInput)
    .mutation(({ input, ctx }) =>
      withTenantIsolationBypass(async () => {
        await assertVenueAvailable(db, { tenantId: input.tenantId, venueId: input.venueId })
        try {
          return await createMediaTemporalOperationalHandoff({
            client: db,
            input,
            actorId: ctx.session.userId,
          })
        } catch (error) {
          if (error instanceof MediaTemporalOperationalError)
            throw new TRPCError({
              code: error.code === 'CONFLICT' ? 'CONFLICT' : 'BAD_REQUEST',
              message: error.message,
              cause: error,
            })
          throw error
        }
      }),
    ),
  retainTemporalReview: adminProcedure.input(MediaTemporalReceiptInput).mutation(({ input, ctx }) =>
    withTenantIsolationBypass(async () => {
      await assertVenueAvailable(db, { tenantId: input.tenantId, venueId: input.venueId })
      try {
        return await createMediaTemporalReviewReceipt({
          client: db,
          input,
          actorId: ctx.session.userId,
        })
      } catch (error) {
        if (error instanceof MediaTemporalReceiptError)
          throw new TRPCError({
            code: error.code === 'CONFLICT' ? 'CONFLICT' : 'BAD_REQUEST',
            message: error.message,
            cause: error,
          })
        throw error
      }
    }),
  ),
  readTemporalReviewEvidence: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1).max(191),
          venueId: z.string().min(1).max(191),
          receiptId: z.string().uuid(),
          offset: z.number().int().min(0).max(8_000_000).default(0),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        await assertVenueAvailable(db, { tenantId: input.tenantId, venueId: input.venueId })
        const receipt = await db.mediaTemporalReviewReceipt.findFirst({
          where: { id: input.receiptId, tenantId: input.tenantId, venueId: input.venueId },
          select: { snapshot: true, snapshotHash: true, requestHash: true, actorId: true },
        })
        if (!receipt)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Temporal review not found.' })
        let snapshot: ReturnType<typeof validateMediaTemporalReviewSnapshot>
        try {
          snapshot = validateMediaTemporalReviewSnapshot(receipt.snapshot)
        } catch (error) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Temporal receipt failed its integrity check.',
            cause: error,
          })
        }
        if (
          mediaIntakeHash(snapshot) !== receipt.snapshotHash ||
          snapshot.tenantId !== input.tenantId ||
          snapshot.venueId !== input.venueId ||
          snapshot.reviewedBy !== receipt.actorId ||
          mediaIntakeHash({
            input: mediaTemporalReceiptInput(snapshot),
            actorId: receipt.actorId,
          }) !== receipt.requestHash
        )
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Temporal receipt failed its integrity check.',
          })
        const text = JSON.stringify(snapshot, null, 2)
        if (
          input.offset > text.length ||
          (input.offset > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(input.offset)))
        )
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid evidence page offset.' })
        let end = Math.min(input.offset + 20_000, text.length)
        if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end -= 1
        return {
          receiptId: input.receiptId,
          snapshotHash: receipt.snapshotHash,
          requestHash: receipt.requestHash,
          text: text.slice(input.offset, end),
          offset: input.offset,
          nextOffset: end < text.length ? end : null,
          totalCodeUnits: text.length,
        }
      }),
    ),
  createTemporalClarification: adminProcedure
    .input(MediaTemporalClarificationInput)
    .mutation(({ input }) =>
      withTenantIsolationBypass(async () => {
        await assertVenueAvailable(db, { tenantId: input.tenantId, venueId: input.venueId })
        try {
          return await createMediaTemporalClarification({ client: db, input })
        } catch (error) {
          if (error instanceof MediaTemporalClarificationError)
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: error.message,
              cause: error,
            })
          throw error
        }
      }),
    ),
  previewTemporalReview: adminProcedure.input(MediaTemporalReviewInput).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      await assertVenueAvailable(db, { tenantId: input.tenantId, venueId: input.venueId })
      try {
        return await previewMediaTemporalReview({
          db,
          input,
          evaluatedAt: new Date().toISOString(),
        })
      } catch (error) {
        if (error instanceof MediaTemporalReviewError)
          throw new TRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'TOO_LARGE'
                  ? 'PAYLOAD_TOO_LARGE'
                  : 'PRECONDITION_FAILED',
            message: error.message,
            cause: error,
          })
        throw error
      }
    }),
  ),
})
