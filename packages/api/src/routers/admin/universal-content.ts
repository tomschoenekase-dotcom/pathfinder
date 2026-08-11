import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const moduleKind = z.enum(['SERVICE', 'POLICY', 'EVENT', 'OPERATIONAL_FACT', 'RELATIONSHIP'])

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
        nextCursor:
          rows.length > input.limit && last
            ? { createdAt: last.createdAt.toISOString(), id: last.id }
            : null,
      }
    }),
})
