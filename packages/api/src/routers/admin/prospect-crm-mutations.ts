import { z } from 'zod'

import {
  addProspectNoteAction,
  archiveProspectAction,
  createProspectAction,
  linkProspectConversionAction,
  updateProspectPipelineAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  mapProspectActionError,
  prospectActor,
  prospectBoundedText,
  prospectPriority,
  prospectStage,
} from './prospect-crm-common'

export const adminProspectCrmMutationsRouter = router({
  createProspect: adminProcedure
    .input(
      z
        .object({
          organization: z
            .object({
              canonicalName: prospectBoundedText(300),
              aliases: z.array(prospectBoundedText(300)).max(20).optional(),
              website: z.string().trim().max(2000).optional(),
              organizationType: z.string().trim().max(200).optional(),
              description: z.string().trim().max(5000).optional(),
              territoryId: z.string().min(1).max(191).optional(),
              source: z.string().trim().max(500).optional(),
              ownerId: z.string().trim().max(191).optional(),
              priority: prospectPriority.optional(),
              notes: z.string().trim().max(10000).optional(),
              tags: z.array(prospectBoundedText(100)).max(30).optional(),
            })
            .strict(),
          venue: z
            .object({
              name: prospectBoundedText(300),
              website: z.string().trim().max(2000).optional(),
              venueType: z.string().trim().max(200).optional(),
              city: z.string().trim().max(200).optional(),
              region: z.string().trim().max(100).optional(),
              country: z.string().trim().max(100).optional(),
              notes: z.string().trim().max(10000).optional(),
            })
            .strict()
            .optional(),
          contact: z
            .object({
              fullName: z.string().trim().max(300).optional(),
              title: z.string().trim().max(300).optional(),
              email: z.string().trim().max(320).optional(),
              phone: z.string().trim().max(200).optional(),
              source: z.string().trim().max(500).optional(),
              doNotContact: z.boolean().optional(),
              notes: z.string().trim().max(5000).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        createProspectAction({ ...input, actor: prospectActor(ctx.session.userId) }).catch(
          mapProspectActionError,
        ),
      ),
    ),

  updateProspectPipeline: adminProcedure
    .input(
      z
        .object({
          organizationId: z.string().min(1).max(191),
          stage: prospectStage,
          priority: prospectPriority.optional(),
          ownerId: z.string().trim().max(191).nullable().optional(),
          nextAction: z.string().trim().max(2000).nullable().optional(),
          nextActionAt: z.string().datetime().nullable().optional(),
          reason: z.string().trim().max(2000).optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        updateProspectPipelineAction({
          ...input,
          nextActionAt:
            input.nextActionAt === undefined
              ? undefined
              : input.nextActionAt === null
                ? null
                : new Date(input.nextActionAt),
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      ),
    ),

  addProspectNote: adminProcedure
    .input(
      z
        .object({ organizationId: z.string().min(1).max(191), note: prospectBoundedText(10000) })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        addProspectNoteAction({ ...input, actor: prospectActor(ctx.session.userId) }).catch(
          mapProspectActionError,
        ),
      ),
    ),

  archiveProspect: adminProcedure
    .input(
      z
        .object({
          organizationId: z.string().min(1).max(191),
          archived: z.boolean(),
          reason: prospectBoundedText(2000),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        archiveProspectAction({ ...input, actor: prospectActor(ctx.session.userId) }).catch(
          mapProspectActionError,
        ),
      ),
    ),

  linkProspectConversion: adminProcedure
    .input(
      z
        .object({
          organizationId: z.string().min(1).max(191),
          prospectVenueId: z.string().min(1).max(191).optional(),
          tenantId: z.string().min(1).max(191),
          venueId: z.string().min(1).max(191).optional(),
          evidence: z.record(z.unknown()).optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        linkProspectConversionAction({ ...input, actor: prospectActor(ctx.session.userId) }).catch(
          mapProspectActionError,
        ),
      ),
    ),
})
