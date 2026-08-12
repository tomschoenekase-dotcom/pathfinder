import { z } from 'zod'
import {
  INTAKE_UPLOAD_MAX_BYTES,
  IntakeUploadCursor,
  IntakeUploadMimeType,
} from '@pathfinder/contracts/intake-upload'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { adminSupportScope } from './support-operations-shared'

export const adminSupportAttachmentsRouter = router({
  listEligibleSupportAttachments: adminProcedure
    .input(
      adminSupportScope.extend({
        limit: z.number().int().min(1).max(50).default(20),
        cursor: IntakeUploadCursor.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.intakeUpload.findMany({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          status: 'AWAITING_REVIEW',
          mimeType: { in: IntakeUploadMimeType.options },
          byteSize: { gte: 1, lte: INTAKE_UPLOAD_MAX_BYTES },
          verifiedAt: { not: null },
          storageVersionId: { not: null },
          intakeRunId: { not: null },
          intakeRun: { sourceKind: 'FILE_UPLOAD', status: 'AWAITING_REVIEW' },
          ...(input.cursor
            ? {
                OR: [
                  { createdAt: { lt: new Date(input.cursor.createdAt) } },
                  { createdAt: new Date(input.cursor.createdAt), id: { lt: input.cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          byteSize: true,
          sha256: true,
          verifiedAt: true,
          storageVersionId: true,
          intakeRunId: true,
          intakeRun: {
            select: {
              id: true,
              sourceKind: true,
              status: true,
              evidence: {
                select: {
                  tenantId: true,
                  venueId: true,
                  runId: true,
                  sourceKind: true,
                  locator: true,
                  normalizedHash: true,
                },
              },
            },
          },
          createdAt: true,
        },
      })
      const eligible = rows.filter(
        (upload) =>
          upload.verifiedAt &&
          upload.storageVersionId &&
          upload.intakeRunId &&
          upload.intakeRun?.id === upload.intakeRunId &&
          upload.intakeRun.sourceKind === 'FILE_UPLOAD' &&
          upload.intakeRun.status === 'AWAITING_REVIEW' &&
          IntakeUploadMimeType.safeParse(upload.mimeType).success &&
          upload.byteSize >= 1 &&
          upload.byteSize <= INTAKE_UPLOAD_MAX_BYTES &&
          upload.intakeRun.evidence.length === 1 &&
          upload.intakeRun.evidence[0]?.tenantId === input.tenantId &&
          upload.intakeRun.evidence[0]?.venueId === input.venueId &&
          upload.intakeRun.evidence[0]?.runId === upload.intakeRunId &&
          upload.intakeRun.evidence[0]?.sourceKind === 'FILE_UPLOAD' &&
          upload.intakeRun.evidence[0]?.locator === `intake-upload:${upload.id}` &&
          upload.intakeRun.evidence[0]?.normalizedHash === upload.sha256,
      )
      const included = eligible.slice(0, input.limit)
      const items = included.map((upload) => ({
        intakeUploadId: upload.id,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        byteSize: upload.byteSize,
        createdAt: upload.createdAt,
      }))
      const lastIncluded = included.at(-1)
      const cursorRow =
        included.length === input.limit
          ? lastIncluded
          : rows.length === input.limit + 1
            ? rows.at(-1)
            : null
      return {
        items,
        nextCursor: cursorRow
          ? { createdAt: cursorRow.createdAt.toISOString(), id: cursorRow.id }
          : null,
      }
    }),
})
