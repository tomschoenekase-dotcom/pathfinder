import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import {
  AI_CENTRAL_MODEL_REGISTRY,
  resolveAiWorkloadConfiguration,
  type AiWorkloadId,
} from '@pathfinder/ai'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const inputSchema = z
  .object({
    tenantId: z.string().min(1).max(128),
    venueId: z.string().min(1).max(128),
  })
  .strict()

const workloadIds = Object.keys(AI_CENTRAL_MODEL_REGISTRY).sort() as AiWorkloadId[]

export const adminAiWorkloadConfigurationRouter = router({
  getVenueAiWorkloadConfiguration: adminProcedure
    .input(inputSchema)
    .query(async ({ ctx, input }) => {
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })

      return {
        scope: { tenantId: input.tenantId, venueId: input.venueId },
        readOnly: true as const,
        layers: [
          {
            level: 'PLATFORM' as const,
            availability: 'AVAILABLE' as const,
            detail: 'Versioned registry defaults are active.',
          },
          ...(['WORKLOAD', 'CLIENT', 'VENUE'] as const).map((level) => ({
            level,
            availability: 'UNAVAILABLE' as const,
            detail: 'No persisted override source exists for this layer.',
          })),
        ],
        budgetIntegration: {
          availability: 'UNAVAILABLE' as const,
          detail:
            'No scoped workload budget is persisted here. Runtime AiBudgetGate controls remain separate.',
        },
        workloads: workloadIds.map((workloadId) => {
          const effective = resolveAiWorkloadConfiguration({
            workloadId,
            clientId: input.tenantId,
            venueId: input.venueId,
          })
          return {
            workloadId,
            kind: effective.kind,
            provider: effective.model.provider,
            model: effective.model.model,
            effectiveSource: effective.sources.primaryModelKey,
            fallback: effective.fallback,
            requestBudgetCeilingE8Usd: effective.requestBudgetCeilingE8Usd,
            pricingEstimate: {
              version: effective.model.pricingVersion,
              usdPerMillionTokens: effective.model.pricingUsdPerMillionTokens,
              invoiceAmount: false as const,
            },
            limits: effective.model.limits,
            unsafeChangesEnabled: false as const,
          }
        }),
      }
    }),
})
