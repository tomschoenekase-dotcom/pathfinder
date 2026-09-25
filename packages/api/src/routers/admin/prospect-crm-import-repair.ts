import { z } from 'zod'

import {
  previewProspectImportRepairAction,
  repairProspectImportAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

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
})
