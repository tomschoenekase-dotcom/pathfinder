import { z } from 'zod'

import { previewRetentionDispositionAction } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminRetentionDispositionPreviewRouter = router({
  previewRetentionDisposition: adminProcedure
    .input(z.object({ tenantId: z.string().trim().min(1).max(191) }).strict())
    .query(({ ctx, input }) =>
      previewRetentionDispositionAction({ tenantId: input.tenantId }, ctx.db as never),
    ),
})
