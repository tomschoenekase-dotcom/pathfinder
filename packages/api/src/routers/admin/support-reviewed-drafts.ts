import { z } from 'zod'

import { router } from '../../core'
import { supportReviewedDraftFinalizer } from '../../lib/admin-reviewed-draft-finalizers'
import { createVenuePackageDraftService } from '../venue-package'
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
      createVenuePackageDraftService({
        db: ctx.db,
        tenantId: input.tenantId,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        input: { venueId: input.venueId, draftKey: input.draftKey, payload: input.payload },
        finalizer: supportReviewedDraftFinalizer({
          actorId: ctx.session.userId,
          supportRequestId: input.supportRequestId,
          expectedVersion: input.expectedVersion,
        }),
      }),
    ),
})
