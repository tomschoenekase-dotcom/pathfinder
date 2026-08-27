import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  RegisterVenueMediaAssetInput,
  RequestVenueMediaDerivativesInput,
  ReviewVenueMediaAssetInput,
} from '@pathfinder/contracts'
import {
  registerVenueMediaAssetAction,
  requestVenueMediaDerivativesAction,
  resolveApprovedVenueMediaCandidates,
  reviewVenueMediaAssetAction,
  VenueMediaActionError,
} from '@pathfinder/db'
import { enqueueVenueMediaDerivative } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

function actionError(error: unknown): never {
  if (error instanceof VenueMediaActionError) {
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

export const adminIntakeMediaAssetRouter = router({
  registerVenueMediaAsset: adminProcedure
    .input(RegisterVenueMediaAssetInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await registerVenueMediaAssetAction({
          db: ctx.db,
          registration: input,
          actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
      } catch (error) {
        actionError(error)
      }
    }),
  reviewVenueMediaAsset: adminProcedure
    .input(ReviewVenueMediaAssetInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await reviewVenueMediaAssetAction({
          db: ctx.db,
          review: input,
          actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
      } catch (error) {
        actionError(error)
      }
    }),
  requestVenueMediaDerivatives: adminProcedure
    .input(RequestVenueMediaDerivativesInput)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await requestVenueMediaDerivativesAction({
          db: ctx.db,
          request: input,
          actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
        await Promise.all(
          result.items
            .filter((item) => item.status === 'PENDING')
            .map((item) =>
              enqueueVenueMediaDerivative({
                tenantId: input.tenantId,
                venueId: input.venueId,
                derivativeId: item.derivativeId,
              }),
            ),
        )
        return result
      } catch (error) {
        actionError(error)
      }
    }),
  listApprovedVenueMediaCandidates: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().trim().min(1),
          venueId: z.string().trim().min(1),
          maximumAssets: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return {
          items: await resolveApprovedVenueMediaCandidates({ db: ctx.db, ...input }),
          visitorDelivery: 'NOT_IMPLEMENTED' as const,
          hotlinking: 'FORBIDDEN' as const,
          nextGate: 'CONTROLLED_DERIVATIVE_DELIVERY' as const,
        }
      } catch (error) {
        actionError(error)
      }
    }),
})
