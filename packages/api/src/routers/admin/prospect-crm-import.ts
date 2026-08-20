import { z } from 'zod'

import {
  approveProspectImportAction,
  beginProspectImportAction,
  commitProspectImportBatchAction,
  db,
  resolveProspectImportRowAction,
  stageProspectImportRowsAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  mapProspectActionError,
  normalizedProspectImportRow,
  prospectActor,
  prospectBoundedText,
} from './prospect-crm-common'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/)

export const adminProspectCrmImportRouter = router({
  beginProspectImport: adminProcedure
    .input(
      z
        .object({
          fileName: prospectBoundedText(500),
          fileType: z.enum(['csv', 'xlsx']),
          fileSize: z
            .number()
            .int()
            .min(1)
            .max(25 * 1024 * 1024),
          fileHash: sha256,
          mappingHash: sha256,
          mapping: z.record(z.unknown()),
          sheets: z
            .array(
              z
                .object({
                  sheetName: prospectBoundedText(300),
                  sheetIndex: z.number().int().min(0).max(99),
                  detectedRows: z.number().int().min(0),
                  columns: z.array(z.string().max(300)).max(100),
                })
                .strict(),
            )
            .min(1)
            .max(100),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        beginProspectImportAction({ ...input, actor: prospectActor(ctx.session.userId) }).catch(
          mapProspectActionError,
        ),
      ),
    ),

  stageProspectImportRows: adminProcedure
    .input(
      z
        .object({
          importId: z.string().min(1).max(191),
          rows: z
            .array(
              z
                .object({
                  sheetName: prospectBoundedText(300),
                  originalRowNumber: z.number().int().min(2),
                  sourceValues: z.record(z.unknown()),
                  normalizedValues: normalizedProspectImportRow,
                })
                .strict(),
            )
            .min(1)
            .max(250),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        stageProspectImportRowsAction({ ...input, actor: prospectActor(ctx.session.userId) }).catch(
          mapProspectActionError,
        ),
      ),
    ),

  getProspectImport: adminProcedure
    .input(
      z
        .object({
          importId: z.string().min(1).max(191),
          rowStatus: z
            .enum(['VALID', 'WARNING', 'DUPLICATE_REVIEW', 'IMPORTED', 'FAILED', 'SKIPPED'])
            .optional(),
          rowLimit: z.number().int().min(1).max(200).default(200),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const [prospectImport, rows] = await Promise.all([
          db.prospectImport.findUniqueOrThrow({
            where: { id: input.importId },
            include: { sheets: { orderBy: { sheetIndex: 'asc' } } },
          }),
          db.prospectImportRow.findMany({
            where: {
              importId: input.importId,
              ...(input.rowStatus ? { status: input.rowStatus } : {}),
            },
            orderBy: [{ sheetName: 'asc' }, { originalRowNumber: 'asc' }],
            take: input.rowLimit,
          }),
        ])
        return { prospectImport, rows }
      }),
    ),

  listProspectImports: adminProcedure.query(() =>
    withTenantIsolationBypass(() =>
      db.prospectImport.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          fileName: true,
          status: true,
          totalRows: true,
          validRows: true,
          warningRows: true,
          duplicateRows: true,
          failedRows: true,
          importedRows: true,
          createdBy: true,
          approvedBy: true,
          approvedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ),
  ),

  resolveProspectImportRow: adminProcedure
    .input(
      z
        .object({
          importId: z.string().min(1).max(191),
          rowId: z.string().min(1).max(191),
          decision: z.enum(['IMPORT_AS_DISTINCT', 'SKIP']),
          note: prospectBoundedText(2000),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        resolveProspectImportRowAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      ),
    ),

  approveProspectImport: adminProcedure
    .input(z.object({ importId: z.string().min(1).max(191) }).strict())
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        approveProspectImportAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      ),
    ),

  commitProspectImportBatch: adminProcedure
    .input(
      z
        .object({
          importId: z.string().min(1).max(191),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        commitProspectImportBatchAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      ),
    ),
})
