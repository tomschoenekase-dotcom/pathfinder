import { randomUUID } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  approveProspectImportAction,
  cancelProspectImportAction,
  configureProspectImportMappingAction,
  beginProspectImportAction,
  db,
  reserveProspectImportUploadAction,
  resolveProspectImportRowAction,
  stageProspectImportRowsAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import {
  enqueueProspectImportCommit,
  enqueueProspectImportInspection,
  enqueueProspectImportStaging,
} from '@pathfinder/jobs'
import {
  createProspectImportObjectKey,
  inspectProspectImportUpload,
  signProspectImportUpload,
} from '../../prospect-import-storage'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  mapProspectActionError,
  normalizedProspectImportRow,
  prospectActor,
  prospectBoundedText,
} from './prospect-crm-common'
import {
  assertProspectImportManifest,
  assertProspectSourceRow,
  ProspectImportLimitError,
} from './prospect-import-limits'
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
export const adminProspectCrmImportRouter = router({
  reserveProspectImportUpload: adminProcedure
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
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const generation = randomUUID()
      const key = createProspectImportObjectKey()
      const contentType =
        input.fileType === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv'
      const reserved = await withTenantIsolationBypass(() =>
        reserveProspectImportUploadAction({
          ...input,
          sourceObjectKey: key,
          sourceObjectGeneration: generation,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      )
      const upload = await signProspectImportUpload({
        key,
        generation,
        contentType,
        bytes: input.fileSize,
        checksumSha256: input.fileHash,
      })
      return { importId: reserved.prospectImport.id, ...upload }
    }),

  completeProspectImportUpload: adminProcedure
    .input(z.object({ importId: z.string().min(1).max(191) }).strict())
    .mutation(async ({ input }) => {
      const prospectImport = await withTenantIsolationBypass(() =>
        db.prospectImport.findUnique({ where: { id: input.importId } }),
      )
      if (
        !prospectImport ||
        !prospectImport.sourceObjectKey ||
        !prospectImport.sourceObjectGeneration
      ) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Import upload reservation not found' })
      }
      const contentType =
        prospectImport.fileType === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv'
      const inspection = await inspectProspectImportUpload({
        key: prospectImport.sourceObjectKey,
        generation: prospectImport.sourceObjectGeneration,
        contentType,
        bytes: prospectImport.fileSize,
        checksumSha256: prospectImport.fileHash,
      })
      if (inspection.state !== 'verified') {
        throw new TRPCError({
          code: inspection.state === 'missing' ? 'NOT_FOUND' : 'BAD_REQUEST',
          message: `Immutable workbook upload is ${inspection.state}`,
        })
      }
      await withTenantIsolationBypass(() =>
        db.prospectImport.update({
          where: { id: input.importId },
          data: { sourceObjectVersion: inspection.versionId, progressCursor: 'UPLOADED' },
        }),
      )
      await enqueueProspectImportInspection({ importId: input.importId })
      return { queued: true }
    }),

  configureProspectImportMapping: adminProcedure
    .input(
      z
        .object({
          importId: z.string().min(1).max(191),
          mappingHash: sha256,
          mapping: z.record(z.unknown()),
          selectedSheets: z.array(prospectBoundedText(300)).min(1).max(100),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await withTenantIsolationBypass(() =>
        configureProspectImportMappingAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      )
      await enqueueProspectImportStaging({ importId: input.importId })
      return { prospectImport: result, queued: true }
    }),

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
          expandedXlsxBytes: z
            .number()
            .int()
            .min(1)
            .max(150 * 1024 * 1024)
            .optional(),
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
    .mutation(({ ctx, input }) => {
      try {
        assertProspectImportManifest(input)
      } catch (error) {
        if (error instanceof ProspectImportLimitError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message })
        }
        throw error
      }
      const { expandedXlsxBytes: _expandedXlsxBytes, ...actionInput } = input
      void _expandedXlsxBytes
      return withTenantIsolationBypass(() =>
        beginProspectImportAction({
          ...actionInput,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      )
    }),

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
    .mutation(({ ctx, input }) => {
      try {
        for (const row of input.rows) assertProspectSourceRow(row.sourceValues)
      } catch (error) {
        if (error instanceof ProspectImportLimitError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message })
        }
        throw error
      }
      return withTenantIsolationBypass(() =>
        stageProspectImportRowsAction({ ...input, actor: prospectActor(ctx.session.userId) }).catch(
          mapProspectActionError,
        ),
      )
    }),

  getProspectImport: adminProcedure
    .input(
      z
        .object({
          importId: z.string().min(1).max(191),
          rowStatus: z
            .enum([
              'VALID',
              'WARNING',
              'DUPLICATE_REVIEW',
              'PROCESSING',
              'IMPORTED',
              'FAILED',
              'SKIPPED',
              'QUARANTINED',
            ])
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
          decision: z.enum([
            'CREATE_DISTINCT',
            'LINK_EXISTING',
            'UPDATE_EXISTING',
            'SKIP',
            'QUARANTINE',
            'NOT_DUPLICATE',
          ]),
          targetOrganizationId: z.string().min(1).max(191).optional(),
          targetVenueId: z.string().min(1).max(191).optional(),
          targetContactId: z.string().min(1).max(191).optional(),
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
    .mutation(async ({ ctx, input }) => {
      const result = await withTenantIsolationBypass(() =>
        approveProspectImportAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      )
      await enqueueProspectImportCommit({ importId: input.importId })
      return { ...result, queued: true }
    }),

  retryProspectImportJob: adminProcedure
    .input(
      z
        .object({
          importId: z.string().min(1).max(191),
        })
        .strict(),
    )
    .mutation(async ({ input }) => {
      const prospectImport = await withTenantIsolationBypass(() =>
        db.prospectImport.findUnique({ where: { id: input.importId } }),
      )
      if (!prospectImport) throw new TRPCError({ code: 'NOT_FOUND', message: 'Import not found' })
      if (prospectImport.status === 'DRAFT') {
        if (prospectImport.progressCursor === 'UPLOADED') {
          await enqueueProspectImportInspection({ importId: input.importId })
          return { queued: true, phase: 'inspection' as const }
        }
        if (
          prospectImport.progressCursor === 'MAPPED' ||
          /^\d+:\d+$/u.test(prospectImport.progressCursor ?? '')
        ) {
          await enqueueProspectImportStaging({ importId: input.importId })
          return { queued: true, phase: 'staging' as const }
        }
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Import requires upload completion or mapping review before retry',
        })
      }
      if (!['APPROVED', 'PROCESSING', 'PARTIAL'].includes(prospectImport.status)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Import is not eligible for worker retry',
        })
      }
      await enqueueProspectImportCommit({ importId: input.importId })
      return { queued: true, phase: 'commit' as const }
    }),

  cancelProspectImport: adminProcedure
    .input(
      z
        .object({
          importId: z.string().min(1).max(191),
          reason: prospectBoundedText(500),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        cancelProspectImportAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      ),
    ),
})
