import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { getVenueDistributionSessionCounts, resolveVenueDistribution } from '@pathfinder/db'

import { router } from '../../core'
import { requireRole } from '../../middleware/require-role'
import { tenantProcedure } from '../../trpc'

export const tenantDistributionReadbackRouter = router({
  readback: tenantProcedure
    .use(requireRole('STAFF'))
    .input(z.object({ venueId: z.string().min(1).max(128) }).strict())
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: {
          id: true,
          slug: true,
          name: true,
          isActive: true,
          chatTheme: true,
          chatAccentColor: true,
        },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      const resolved = await resolveVenueDistribution({
        client: ctx.db,
        venueSlug: venue.slug,
        venueTarget: { venueId: venue.id, tenantId },
      })
      if (!resolved || resolved.venueId !== venue.id || resolved.tenantId !== tenantId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }
      const sessions30d = await getVenueDistributionSessionCounts(ctx.db, tenantId, venue.id)
      return {
        venue,
        website: resolved.website,
        app: resolved.app,
        revision: resolved.revision,
        sessions30d,
      }
    }),
})
