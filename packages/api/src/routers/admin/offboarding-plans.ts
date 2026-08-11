import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  OffboardingExportKind,
  OffboardingRevocationTarget,
} from '@pathfinder/contracts/offboarding'
import { writeAuditLogStrict } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const tenantScope = z.object({ tenantId: z.string().min(1) }).strict()
const cursor = z
  .object({ requestedAt: z.string().datetime({ offset: true }), id: z.string().min(1) })
  .strict()

const planSummarySelect = {
  id: true,
  tenantId: true,
  status: true,
  revocationTargets: true,
  exportKinds: true,
  effectiveAt: true,
  requestedBy: true,
  requestedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { venueTargets: true } },
} as const

export const adminOffboardingPlansRouter = router({
  listOffboardingPlans: adminProcedure
    .input(
      tenantScope.extend({
        cursor: cursor.optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      const requestedAt = input.cursor ? new Date(input.cursor.requestedAt) : null
      const rows = await ctx.db.offboardingPlan.findMany({
        where: {
          tenantId: input.tenantId,
          ...(input.cursor
            ? {
                OR: [
                  { requestedAt: { lt: requestedAt! } },
                  { requestedAt: requestedAt!, id: { lt: input.cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: planSummarySelect,
      })
      const items = rows.slice(0, input.limit)
      const last = items.at(-1)
      return {
        items,
        nextCursor:
          rows.length > input.limit && last
            ? { requestedAt: last.requestedAt.toISOString(), id: last.id }
            : null,
      }
    }),

  getOffboardingPlan: adminProcedure
    .input(tenantScope.extend({ planId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const plan = await ctx.db.offboardingPlan.findFirst({
        where: { id: input.planId, tenantId: input.tenantId },
        select: {
          ...planSummarySelect,
          venueTargets: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              venueId: true,
              createdAt: true,
              revocationEvidence: {
                orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
                select: {
                  id: true,
                  target: true,
                  outcome: true,
                  evidenceReference: true,
                  errorCode: true,
                  recordedBy: true,
                  recordedAt: true,
                },
              },
              exportArtifacts: {
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: {
                  id: true,
                  kind: true,
                  artifactReference: true,
                  contentHash: true,
                  createdBy: true,
                  createdAt: true,
                },
              },
            },
          },
        },
      })
      if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Offboarding plan not found' })
      return plan
    }),

  createOffboardingDraft: adminProcedure
    .input(
      tenantScope
        .extend({
          venueIds: z.array(z.string().min(1)).min(1).max(100),
          revocationTargets: z
            .array(OffboardingRevocationTarget)
            .min(1)
            .max(OffboardingRevocationTarget.options.length),
          exportKinds: z
            .array(OffboardingExportKind)
            .max(OffboardingExportKind.options.length)
            .default([]),
          effectiveAt: z.string().datetime({ offset: true }).optional(),
        })
        .superRefine((value, context) => {
          for (const [field, values] of [
            ['venueIds', value.venueIds],
            ['revocationTargets', value.revocationTargets],
            ['exportKinds', value.exportKinds],
          ] as const) {
            if (new Set(values).size !== values.length) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [field],
                message: `${field} must not contain duplicates`,
              })
            }
          }
        }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const venues = await tx.venue.findMany({
          where: { tenantId: input.tenantId, id: { in: input.venueIds } },
          select: { id: true },
        })
        if (venues.length !== input.venueIds.length) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'One or more venues were not found' })
        }

        const plan = await tx.offboardingPlan.create({
          data: {
            tenantId: input.tenantId,
            status: 'REQUESTED',
            revocationTargets: input.revocationTargets,
            exportKinds: input.exportKinds,
            ...(input.effectiveAt !== undefined
              ? { effectiveAt: new Date(input.effectiveAt) }
              : {}),
            requestedBy: ctx.session.userId,
            venueTargets: {
              create: input.venueIds.map((venueId) => ({ tenantId: input.tenantId, venueId })),
            },
          },
          select: planSummarySelect,
        })
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: ctx.session.userId,
            actorRole: 'PLATFORM_ADMIN',
            action: 'offboarding-plan.draft-created',
            targetType: 'OffboardingPlan',
            targetId: plan.id,
            afterState: {
              status: 'REQUESTED',
              venueCount: input.venueIds.length,
              revocationTargets: input.revocationTargets,
              exportKinds: input.exportKinds,
            },
          },
          tx,
        )
        return plan
      })
    }),
})
