import type { TRPCContext } from '../context'
import { VenuePackageDraftInput } from '../schemas/venue-package'
import { venuePackageRouter } from '../routers/venue-package'
import {
  withVenuePackageDraftFinalizer,
  type VenuePackageDraftFinalizer,
  VenuePackageDraftFinalizerError,
} from './venue-package-draft-finalizer'

export async function runAdminReviewedDraftOrchestration(input: {
  ctx: TRPCContext
  tenantId: string
  draft: unknown
  finalizer: VenuePackageDraftFinalizer
}) {
  if (!input.ctx.session.userId) throw new Error('Authenticated administrator required')
  const draft = VenuePackageDraftInput.parse(input.draft)
  const caller = venuePackageRouter.createCaller({
    ...input.ctx,
    session: {
      ...input.ctx.session,
      activeTenantId: input.tenantId,
      role: 'MANAGER',
      isPlatformAdmin: true,
    },
  })
  try {
    return await withVenuePackageDraftFinalizer(input.finalizer, () => caller.createDraft(draft))
  } catch (error) {
    if (error instanceof VenuePackageDraftFinalizerError) throw error.cause
    throw error
  }
}
