import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import {
  db,
  previewProspectImportRepairAction,
  repairProspectImportAction,
  resumeIncompleteProspectImportDryRunAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import {
  enqueueProspectImportCommit,
  enqueueProspectImportInspection,
  enqueueProspectImportStaging,
} from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { mapProspectActionError, prospectActor, prospectBoundedText } from './prospect-crm-common'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/)

export const adminProspectCrmImportRepairRouter = router({
  previewProspectImportRepair: adminProcedure
    .input(z.object({ importId: z.string().min(1).max(191) }).strict())
    .query(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        previewProspectImportRepairAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      ),
    ),

  repairProspectImport: adminProcedure
    .input(
      z
        .object({
          importId: z.string().min(1).max(191),
          expectedPlanHash: sha256,
          reason: prospectBoundedText(500),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        repairProspectImportAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      ),
    ),

  retryProspectImportJob: adminProcedure
    .input(
      z
        .object({
          importId: z.string().min(1).max(191),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const prospectImport = await withTenantIsolationBypass(() =>
        db.prospectImport.findUnique({ where: { id: input.importId } }),
      )
      if (!prospectImport) throw new TRPCError({ code: 'NOT_FOUND', message: 'Import not found' })
      if (
        prospectImport.status === 'DRY_RUN_READY' &&
        prospectImport.sourceObjectKey &&
        prospectImport.progressCursor !== 'DRY_RUN_READY'
      ) {
        await withTenantIsolationBypass(() =>
          resumeIncompleteProspectImportDryRunAction({
            importId: input.importId,
            actor: prospectActor(ctx.session.userId),
          }).catch(mapProspectActionError),
        )
        await enqueueProspectImportStaging({ importId: input.importId })
        return { queued: true, phase: 'staging' as const }
      }
      if (prospectImport.status === 'DRAFT') {
        if (prospectImport.progressCursor === 'UPLOADED') {
          await enqueueProspectImportInspection({ importId: input.importId })
          return { queued: true, phase: 'inspection' as const }
        }
        if (
          prospectImport.progressCursor === 'MAPPED' ||
          /^\d+:\d+$/u.test(prospectImport.progressCursor ?? '')
        ) {
          await withTenantIsolationBypass(() =>
            resumeIncompleteProspectImportDryRunAction({
              importId: input.importId,
              actor: prospectActor(ctx.session.userId),
            }).catch(mapProspectActionError),
          )
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
})
