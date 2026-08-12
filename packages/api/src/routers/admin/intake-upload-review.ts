import { z } from 'zod'

import {
  getIntakeUploadDetailAction,
  IntakeUploadActionError,
  listIntakeUploadsAction,
} from '@pathfinder/db'
import { IntakeUploadCursor } from '@pathfinder/contracts/intake-upload'

import { publicTRPCError, router } from '../../core'
import { adminProcedure } from '../../trpc'

const tenantId = z.string().trim().min(1).max(191)
const venueId = z.string().trim().min(1).max(191)
const uploadId = z.string().trim().min(1).max(191)

function mapActionError(error: unknown): never {
  if (error instanceof IntakeUploadActionError) {
    throw publicTRPCError({
      code:
        error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'CONFLICT',
      message: error.message,
    })
  }
  throw error
}

function reviewMetadata(upload: {
  id: string
  status: string
  displayName: string
  fileName: string
  mimeType: string
  byteSize: number
  rejectionCode: string | null
  intakeRunId: string | null
  createdAt: Date
  updatedAt: Date
  verifiedAt?: Date | null
  rejectedAt?: Date | null
}) {
  return {
    id: upload.id,
    status: upload.status,
    displayName: upload.displayName,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    byteSize: upload.byteSize,
    rejectionCode: upload.rejectionCode,
    intakeRunId: upload.intakeRunId,
    createdAt: upload.createdAt,
    updatedAt: upload.updatedAt,
    ...('verifiedAt' in upload ? { verifiedAt: upload.verifiedAt ?? null } : {}),
    ...('rejectedAt' in upload ? { rejectedAt: upload.rejectedAt ?? null } : {}),
  }
}

export const adminIntakeUploadReviewRouter = router({
  listIntakeUploads: adminProcedure
    .input(
      z
        .object({
          tenantId,
          venueId,
          limit: z.number().int().min(1).max(50).default(25),
          cursor: IntakeUploadCursor.optional(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        const result = await listIntakeUploadsAction({
          client: ctx.db,
          tenantId: input.tenantId,
          venueId: input.venueId,
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        })
        return { items: result.items.map(reviewMetadata), nextCursor: result.nextCursor }
      } catch (error) {
        mapActionError(error)
      }
    }),

  getIntakeUploadDetail: adminProcedure
    .input(z.object({ tenantId, venueId, uploadId }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const result = await getIntakeUploadDetailAction({ client: ctx.db, ...input })
        // Explicit projection prevents future domain additions from leaking storage identity,
        // checksums, signed URLs, byte content, or raw transport errors.
        return reviewMetadata(result)
      } catch (error) {
        mapActionError(error)
      }
    }),
})
