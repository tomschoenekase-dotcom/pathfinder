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

const brandingReceipt = z
  .object({
    assetId: z.string().uuid(),
    derivativeId: z.string().uuid(),
    sourceObjectGeneration: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    approvedReviewSequence: z.number().int().positive(),
  })
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
    chatLogoDerivativeId: z.string().uuid().nullable().optional(),
    chatBannerDerivativeId: z.string().uuid().nullable().optional(),
    chatLogoDerivativeReceipt: brandingReceipt.nullable().optional(),
    chatBannerDerivativeReceipt: brandingReceipt.nullable().optional(),
    chatShowPhotos: z.boolean().optional(),
    chatShowLinks: z.boolean().optional(),
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
  chatLogoDerivativeId: true,
  chatBannerDerivativeId: true,
  chatLogoDerivativeReceipt: true,
  chatBannerDerivativeReceipt: true,
  chatShowPhotos: true,
  chatShowLinks: true,
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
  listGuestBrandingAssets: adminProcedure
    .input(
      scope.extend({
        cursor: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(50).default(50),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true, slug: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue design not found' })
        const approved: Array<{
          id: string
          assetId: string
          variant: string
          approvedReviewSequence: number
          sha256: string | null
          sourceObjectGeneration: string
          asset: {
            kind: string
            altText: string
            caption: string | null
            reviews: Array<{ sequence: number; action: string; rightsBasis: string | null }>
          }
        }> = []
        let scanCursor = input.cursor
        let scannedPages = 0
        const maxScanPages = 5
        while (approved.length <= input.limit && scannedPages < maxScanPages) {
          const rows = await db.venueMediaDerivative.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              status: 'READY',
              mimeType: 'image/webp',
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}),
            take: input.limit + 1,
            select: {
              id: true,
              assetId: true,
              variant: true,
              approvedReviewSequence: true,
              sha256: true,
              sourceObjectGeneration: true,
              asset: {
                select: {
                  kind: true,
                  altText: true,
                  caption: true,
                  reviews: {
                    orderBy: { sequence: 'desc' },
                    take: 1,
                    select: { sequence: true, action: true, rightsBasis: true },
                  },
                },
              },
            },
          })
          scannedPages += 1
          approved.push(
            ...rows.filter((row) => {
              const latest = row.asset.reviews[0]
              return (
                row.asset.kind === 'IMAGE' &&
                latest?.sequence === row.approvedReviewSequence &&
                latest.action === 'APPROVE_CONTENT_USE' &&
                latest.rightsBasis !== null &&
                row.sha256 !== null
              )
            }),
          )
          if (rows.length < input.limit + 1) break
          scanCursor = rows.at(-1)!.id
        }
        const items = approved.slice(0, input.limit)
        return {
          items: items.map((row) => ({
            derivativeId: row.id,
            assetId: row.assetId,
            variant: row.variant,
            altText: row.asset.altText,
            caption: row.asset.caption,
            approvedReviewSequence: row.approvedReviewSequence,
            sourceObjectGeneration: row.sourceObjectGeneration,
            sha256: row.sha256!,
            deliveryPath: `/api/venue-media/${row.id}?venue=${encodeURIComponent(venue.slug)}`,
          })),
          nextCursor:
            approved.length > input.limit
              ? (items.at(-1)?.id ?? null)
              : scannedPages === maxScanPages
                ? (scanCursor ?? null)
                : null,
        }
      }),
    ),

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
