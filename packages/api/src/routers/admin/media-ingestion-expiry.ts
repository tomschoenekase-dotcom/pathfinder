import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { logger } from '@pathfinder/config'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { settleClaimedMediaUploadAbort } from './media-ingestion-abort'

type ExpiryCandidate = {
  id: string
  stage: string
  uploadAttemptId: string
  uploadStartedAt: Date
  sourceObjectKey: string
  storageUploadId: string
}

function isExpiryCandidate(row: {
  id: string
  stage: string
  uploadAttemptId: string | null
  uploadStartedAt: Date | null
  sourceObjectKey: string | null
  storageUploadId: string | null
}): row is ExpiryCandidate {
  return (
    (row.stage === 'upload' || row.stage === 'aborting') &&
    row.uploadAttemptId !== null &&
    row.uploadStartedAt !== null &&
    row.sourceObjectKey !== null &&
    row.storageUploadId !== null
  )
}

export const mediaIngestionExpiryRouter = router({
  expireAbandonedUploads: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        before: z.coerce.date(),
        limit: z.number().int().min(1).max(25),
        dryRun: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.before.getTime() > Date.now()) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The abandonment cutoff cannot be in the future.',
        })
      }

      const rows = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findMany({
          where: {
            tenantId: input.tenantId,
            status: 'UPLOADING',
            stage: { in: ['upload', 'aborting'] },
            uploadAttemptId: { not: null },
            uploadStartedAt: { not: null, lte: input.before },
            sourceObjectKey: { not: null },
            storageUploadId: { not: null },
          },
          select: {
            id: true,
            stage: true,
            uploadAttemptId: true,
            uploadStartedAt: true,
            sourceObjectKey: true,
            storageUploadId: true,
          },
          orderBy: [{ uploadStartedAt: 'asc' }, { id: 'asc' }],
          take: input.limit + 1,
        }),
      )
      const candidates = rows.filter(isExpiryCandidate)
      const truncated = candidates.length > input.limit
      const selected = candidates.slice(0, input.limit)

      if (input.dryRun) {
        return {
          applied: false,
          truncated,
          candidates: selected.map((candidate) => ({
            projectId: candidate.id,
            uploadAttemptId: candidate.uploadAttemptId,
            uploadStartedAt: candidate.uploadStartedAt,
            stage: candidate.stage,
          })),
          results: [],
        }
      }

      const results: Array<{
        projectId: string
        uploadAttemptId: string
        outcome: 'cancelled' | 'state-changed' | 'unconfirmed'
      }> = []
      for (const candidate of selected) {
        if (candidate.stage === 'upload') {
          const claimed = await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.updateMany({
              where: {
                id: candidate.id,
                tenantId: input.tenantId,
                status: 'UPLOADING',
                stage: 'upload',
                uploadAttemptId: candidate.uploadAttemptId,
                uploadStartedAt: candidate.uploadStartedAt,
                sourceObjectKey: candidate.sourceObjectKey,
                storageUploadId: candidate.storageUploadId,
              },
              data: { stage: 'aborting', error: null },
            }),
          )
          if (claimed.count !== 1) {
            results.push({
              projectId: candidate.id,
              uploadAttemptId: candidate.uploadAttemptId,
              outcome: 'state-changed',
            })
            continue
          }
        } else {
          const current = await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.findFirst({
              where: {
                id: candidate.id,
                tenantId: input.tenantId,
                status: 'UPLOADING',
                stage: 'aborting',
                uploadAttemptId: candidate.uploadAttemptId,
                uploadStartedAt: candidate.uploadStartedAt,
                sourceObjectKey: candidate.sourceObjectKey,
                storageUploadId: candidate.storageUploadId,
              },
              select: { id: true },
            }),
          )
          if (!current) {
            results.push({
              projectId: candidate.id,
              uploadAttemptId: candidate.uploadAttemptId,
              outcome: 'state-changed',
            })
            continue
          }
        }

        try {
          await settleClaimedMediaUploadAbort({
            tenantId: input.tenantId,
            projectId: candidate.id,
            uploadAttemptId: candidate.uploadAttemptId,
            sourceObjectKey: candidate.sourceObjectKey,
            storageUploadId: candidate.storageUploadId,
            resumedAbort: candidate.stage === 'aborting',
            actorId: ctx.session.userId,
            auditAction: 'admin.media_ingestion.upload_expired',
          })
          results.push({
            projectId: candidate.id,
            uploadAttemptId: candidate.uploadAttemptId,
            outcome: 'cancelled',
          })
        } catch (error) {
          const stateChanged = error instanceof TRPCError && error.code === 'CONFLICT'
          if (!stateChanged) {
            logger.warn({
              action: 'media-ingestion.upload-expiry.unconfirmed',
              projectId: candidate.id,
              uploadAttemptId: candidate.uploadAttemptId,
              error: 'Expired upload abort could not be confirmed.',
              errorType: error instanceof Error ? error.name : 'UnknownError',
            })
          }
          results.push({
            projectId: candidate.id,
            uploadAttemptId: candidate.uploadAttemptId,
            outcome: stateChanged ? 'state-changed' : 'unconfirmed',
          })
        }
      }

      return { applied: true, truncated, candidates: [], results }
    }),
})
