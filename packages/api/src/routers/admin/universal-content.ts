import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { isFeatureEnabled } from '@pathfinder/config/feature-flags'
import {
  AddGeneralizedContentRevisionInput,
  CreateGeneralizedContentInput,
  GeneralizedContentRevisionDraft,
  RetireGeneralizedContentInput,
} from '@pathfinder/contracts/universal-content-actions'
import {
  addUniversalContentRevisionAction,
  buildUniversalContentPreview,
  createUniversalContentAction,
  retireUniversalContentAction,
  UniversalContentActionError,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const moduleKind = z.enum(['SERVICE', 'POLICY', 'EVENT', 'OPERATIONAL_FACT', 'RELATIONSHIP'])

function assertCapabilityEnabled(): void {
  if (!isFeatureEnabled('generalizedContentCapabilities')) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Generalized content authoring is disabled by the server-owned feature flag.',
    })
  }
}

function actionError(error: unknown): never {
  if (error instanceof UniversalContentActionError) {
    const code =
      error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.code === 'CONFLICT'
          ? 'CONFLICT'
          : 'BAD_REQUEST'
    throw new TRPCError({ code, message: error.message })
  }
  throw error
}

async function validateDraftReferences(
  db: typeof import('@pathfinder/db').db,
  input: {
    tenantId: string
    venueId: string
    draft: z.infer<typeof GeneralizedContentRevisionDraft>
  },
): Promise<void> {
  const venue = await db.venue.findFirst({
    where: { id: input.venueId, tenantId: input.tenantId },
    select: { id: true },
  })
  if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
  const payload = input.draft.payload
  if ((payload.kind === 'SERVICE' || payload.kind === 'EVENT') && payload.placeId) {
    const place = await db.place.findFirst({
      where: { id: payload.placeId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true },
    })
    if (!place) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'The selected compatibility Place is outside this venue.',
      })
    }
  }
  if (payload.kind === 'RELATIONSHIP') {
    const endpoints = await db.contentModuleIdentity.findMany({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        id: { in: [payload.fromModuleId, payload.toModuleId] },
      },
      select: { id: true },
    })
    if (endpoints.length !== 2) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Both relationship endpoints must exist in this exact tenant and venue.',
      })
    }
  }
}

export const adminUniversalContentRouter = router({
  listUniversalContent: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          kind: moduleKind.optional(),
          cursor: z
            .object({ createdAt: z.string().datetime({ offset: true }), id: z.string().min(1) })
            .strict()
            .optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })

      const cursorDate = input.cursor ? new Date(input.cursor.createdAt) : null
      const rows = await ctx.db.contentModuleIdentity.findMany({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.cursor
            ? {
                OR: [
                  { createdAt: { lt: cursorDate! } },
                  { createdAt: cursorDate!, id: { lt: input.cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          kind: true,
          createdAt: true,
          revisions: {
            orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
            take: 1,
            select: {
              id: true,
              version: true,
              audience: true,
              effectiveFrom: true,
              effectiveUntil: true,
              createdAt: true,
              service: {
                select: { name: true, description: true, availability: true, placeId: true },
              },
              policy: { select: { title: true, rule: true, appliesTo: true } },
              event: {
                select: {
                  name: true,
                  description: true,
                  startsAt: true,
                  endsAt: true,
                  placeId: true,
                },
              },
              operationalFact: { select: { label: true, value: true, expiresAt: true } },
              relationship: {
                select: {
                  fromModuleId: true,
                  toModuleId: true,
                  relationshipType: true,
                  description: true,
                },
              },
              _count: { select: { evidence: true } },
              evidence: {
                orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
                take: 3,
                select: {
                  id: true,
                  sourceId: true,
                  locator: true,
                  capturedAt: true,
                  excerptHash: true,
                },
              },
            },
          },
        },
      })
      const items = rows.slice(0, input.limit)
      const last = items.at(-1)
      return {
        items,
        authoringEnabled: isFeatureEnabled('generalizedContentCapabilities'),
        nextCursor:
          rows.length > input.limit && last
            ? { createdAt: last.createdAt.toISOString(), id: last.id }
            : null,
      }
    }),
  previewUniversalContent: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          draft: GeneralizedContentRevisionDraft,
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      await validateDraftReferences(ctx.db, input)
      return {
        valid: true as const,
        authoringEnabled: isFeatureEnabled('generalizedContentCapabilities'),
        preview: buildUniversalContentPreview(input.draft),
      }
    }),
  createUniversalContent: adminProcedure
    .input(CreateGeneralizedContentInput)
    .mutation(async ({ ctx, input }) => {
      assertCapabilityEnabled()
      try {
        return await createUniversalContentAction({
          db: ctx.db,
          ...input,
          actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
      } catch (error) {
        actionError(error)
      }
    }),
  addUniversalContentRevision: adminProcedure
    .input(AddGeneralizedContentRevisionInput)
    .mutation(async ({ ctx, input }) => {
      assertCapabilityEnabled()
      try {
        return await addUniversalContentRevisionAction({
          db: ctx.db,
          ...input,
          actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
      } catch (error) {
        actionError(error)
      }
    }),
  retireUniversalContent: adminProcedure
    .input(RetireGeneralizedContentInput)
    .mutation(async ({ ctx, input }) => {
      assertCapabilityEnabled()
      try {
        return await retireUniversalContentAction({
          db: ctx.db,
          ...input,
          actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
      } catch (error) {
        actionError(error)
      }
    }),
})
