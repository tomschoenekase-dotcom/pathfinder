import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { isEmbedPreviewEnabled } from '@pathfinder/config/feature-flags'
import { resolveProductEntitlement } from '@pathfinder/db'

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
      if (!isEmbedPreviewEnabled()) return { enabled: false as const }
      // Deliberate public lookup by globally unique slug; no content or secrets are selected.
      const [venue] = await ctx.db.$queryRaw<Array<{ id: string; tenantId: string }>>`
        SELECT id, tenant_id AS "tenantId" FROM venues
         WHERE slug = ${input.venueSlug} AND is_active = true LIMIT 1
      `
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Widget not found.' })
      const entitlement = await resolveProductEntitlement({
        client: ctx.db,
        tenantId: venue.tenantId,
        venueId: venue.id,
        capability: 'widget',
        featureAvailable: true,
      })
      return entitlement.enabled ? { enabled: true as const } : { enabled: false as const }
    }),
})
