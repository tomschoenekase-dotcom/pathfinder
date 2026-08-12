import { z } from 'zod'

import { router } from '../../core'
import { supportReviewedDraftFinalizer } from '../../lib/admin-reviewed-draft-finalizers'
import { runAdminReviewedDraftOrchestration } from '../../lib/admin-reviewed-draft-orchestration'
import { VenuePackagePayload } from '../../schemas/venue-package'
import { adminProcedure } from '../../trpc'

export const adminSupportReviewedDraftRouter = router({
  createAndLinkSupportReviewedVenuePackageDraft: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          supportRequestId: z.string().min(1),
          expectedVersion: z.number().int().positive(),
          draftKey: z.string().uuid(),
          payload: VenuePackagePayload,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      runAdminReviewedDraftOrchestration({
        ctx,
        tenantId: input.tenantId,
        draft: { venueId: input.venueId, draftKey: input.draftKey, payload: input.payload },
        finalizer: supportReviewedDraftFinalizer({
          actorId: ctx.session.userId,
          supportRequestId: input.supportRequestId,
          expectedVersion: input.expectedVersion,
        }),
      }),
    ),
})
