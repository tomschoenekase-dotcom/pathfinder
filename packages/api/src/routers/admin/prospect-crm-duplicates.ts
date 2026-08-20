import { z } from 'zod'

import {
  db,
  resolveProspectDuplicateAction,
  scanProspectDuplicatesAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { mapProspectActionError, prospectActor, prospectBoundedText } from './prospect-crm-common'

export const adminProspectCrmDuplicatesRouter = router({
  listProspectDuplicates: adminProcedure
    .input(
      z
        .object({
          status: z
            .enum(['OPEN', 'CONFIRMED_DUPLICATE', 'CONFIRMED_DISTINCT', 'DISMISSED'])
            .default('OPEN'),
          limit: z.number().int().min(1).max(500).default(100),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(() =>
        db.prospectDuplicateCandidate.findMany({
          where: { status: input.status },
          orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }],
          take: input.limit,
          include: {
            organizationA: {
              select: { id: true, canonicalName: true, website: true, normalizedDomain: true },
            },
            organizationB: {
              select: { id: true, canonicalName: true, website: true, normalizedDomain: true },
            },
          },
        }),
      ),
    ),

  resolveProspectDuplicate: adminProcedure
    .input(
      z
        .object({
          candidateId: z.string().min(1).max(191),
          resolution: z.enum(['CONFIRMED_DUPLICATE', 'CONFIRMED_DISTINCT', 'DISMISSED']),
          note: prospectBoundedText(2000),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        resolveProspectDuplicateAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      ),
    ),

  scanProspectDuplicates: adminProcedure
    .input(
      z
        .object({
          prospectLimit: z.number().int().min(1).max(20_000).optional(),
        })
        .strict()
        .optional(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        scanProspectDuplicatesAction({
          prospectLimit: input?.prospectLimit,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      ),
    ),
})
