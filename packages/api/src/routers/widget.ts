import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { resolveCachedVenueDistribution } from '@pathfinder/db'

import { router } from '../core'
import { publicProcedure } from '../trpc'

export const widgetRouter = router({
  availability: publicProcedure
    .input(
      z
        .object({
          venueSlug: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const resolved = await resolveCachedVenueDistribution({
        client: ctx.db,
        venueSlug: input.venueSlug,
      })
      const venue = resolved
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Widget not found.' })
      return venue.website.framed ? { enabled: true as const } : { enabled: false as const }
    }),
})
