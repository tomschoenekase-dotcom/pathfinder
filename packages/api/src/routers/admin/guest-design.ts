import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  db,
  updateVenueChatDesignAction,
  VenueActionError,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const scope = z
  .object({ tenantId: z.string().min(1).max(128), venueId: z.string().min(1).max(128) })
  .strict()

const fields = z
  .object({
    chatTheme: z.enum(['default', 'forest', 'sunset', 'midnight', 'rose', 'dark']).optional(),
    chatAccentColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/u)
      .nullable()
      .optional(),
    chatFont: z
      .enum(['jakarta', 'inter', 'poppins', 'spaceGrotesk', 'dmSans', 'playfair'])
      .optional(),
    chatLogoUrl: z.string().url().max(500).nullable().optional(),
    chatBannerUrl: z.string().url().max(500).nullable().optional(),
  })
  .strict()

const designSelect = {
  id: true,
  name: true,
  description: true,
  guideMode: true,
  aiGuideName: true,
  chatTheme: true,
  chatAccentColor: true,
  chatFont: true,
  chatLogoUrl: true,
  chatBannerUrl: true,
  updatedAt: true,
} as const

function mapError(error: unknown): never {
  if (error instanceof VenueActionError) {
    throw new TRPCError({
      code:
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'BAD_REQUEST',
      message: error.message,
    })
  }
  throw error
}

export const adminGuestDesignRouter = router({
  getGuestDesign: adminProcedure.input(scope).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      const venue = await db.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: designSelect,
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue design not found' })
      return venue
    }),
  ),

  updateGuestDesign: adminProcedure
    .input(scope.extend({ expectedUpdatedAt: z.coerce.date(), fields }))
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const current = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { chatLogoUrl: true, chatBannerUrl: true },
        })
        if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue design not found' })
        if (
          (input.fields.chatLogoUrl !== undefined &&
            input.fields.chatLogoUrl !== null &&
            input.fields.chatLogoUrl !== current.chatLogoUrl) ||
          (input.fields.chatBannerUrl !== undefined &&
            input.fields.chatBannerUrl !== null &&
            input.fields.chatBannerUrl !== current.chatBannerUrl)
        ) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Only existing reviewed branding assets can be retained or cleared.',
          })
        }
        try {
          return await updateVenueChatDesignAction(
            {
              tenantId: input.tenantId,
              venueId: input.venueId,
              expectedUpdatedAt: input.expectedUpdatedAt,
              actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
              fields: input.fields,
            },
            db,
          )
        } catch (error) {
          mapError(error)
        }
      }),
    ),
})
