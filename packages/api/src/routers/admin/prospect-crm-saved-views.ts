import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { prospectGoodFitCriteria } from '@pathfinder/contracts/prospect-size'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { prospectBoundedText } from './prospect-crm-common'

const id = z.string().min(1).max(191)

export const prospectGoodFitSavedView = {
  name: 'Good fit',
  filters: {
    goodFit: true,
    supportedCategories: prospectGoodFitCriteria.supportedCategories,
    sizeClasses: prospectGoodFitCriteria.eligibleSizeClasses,
    preferredSizeClass: prospectGoodFitCriteria.preferredSizeClass,
    founderPriority: prospectGoodFitCriteria.founderPriority,
    minimumBuyerAttainability: prospectGoodFitCriteria.minimumBuyerAttainability,
    buyerAttainabilityAnyOf: prospectGoodFitCriteria.buyerAttainabilityAnyOf,
    requireTerritory: true,
    excludeEnterpriseDeferral: true,
    excludeOutboundCorrespondence: true,
    excludeCampaignMembership: true,
    excludeDrafts: true,
    excludeOpenOrConfirmedDuplicates: true,
  },
  columns: ['canonicalName', 'organizationType', 'territory', 'priority', 'venues'],
  sort: { sizePreference: ['M', 'S', 'L'], updatedAt: 'desc' },
  isShared: false,
} as const

export const adminProspectCrmSavedViewsRouter = router({
  listProspectSavedViews: adminProcedure.query(({ ctx }) =>
    withTenantIsolationBypass(() =>
      db.prospectSavedView
        .findMany({
          where: { OR: [{ ownerId: ctx.session.userId }, { isShared: true }] },
          orderBy: [{ ownerId: 'asc' }, { name: 'asc' }],
        })
        .then((views) => {
          if (
            views.some(
              (view) =>
                view.ownerId === ctx.session.userId && view.name === prospectGoodFitSavedView.name,
            )
          ) {
            return views
          }
          return [
            { id: 'builtin:good-fit', ownerId: ctx.session.userId, ...prospectGoodFitSavedView },
            ...views,
          ]
        }),
    ),
  ),

  saveProspectView: adminProcedure
    .input(
      z
        .object({
          name: prospectBoundedText(191),
          filters: z.record(z.unknown()),
          columns: z.array(z.string().trim().min(1).max(100)).max(20),
          sort: z.record(z.unknown()).default({}),
          isShared: z.boolean().default(false),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        db.prospectSavedView.upsert({
          where: { ownerId_name: { ownerId: ctx.session.userId, name: input.name } },
          create: { ...input, ownerId: ctx.session.userId },
          update: input,
        }),
      ),
    ),

  deleteProspectView: adminProcedure
    .input(z.object({ viewId: id }).strict())
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const deleted = await db.prospectSavedView.deleteMany({
          where: { id: input.viewId, ownerId: ctx.session.userId },
        })
        if (!deleted.count)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Saved view not found' })
        return { deleted: true }
      }),
    ),
})
