import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminClientSearchRouter = router({
  searchClients: adminProcedure
    .input(
      z
        .object({
          query: z.string().trim().max(100).default(''),
          limit: z.number().int().min(1).max(50).default(20),
          cursor: z
            .object({
              createdAt: z.string().datetime({ offset: true }),
              id: z.string().min(1),
            })
            .strict()
            .optional(),
        })
        .strict(),
    )
    .query(async ({ input }) => {
      const cursorDate = input.cursor ? new Date(input.cursor.createdAt) : null
      const rows = await withTenantIsolationBypass(() =>
        db.tenant.findMany({
          where: {
            ...(input.query
              ? {
                  OR: [
                    { name: { contains: input.query, mode: 'insensitive' as const } },
                    { slug: { contains: input.query, mode: 'insensitive' as const } },
                  ],
                }
              : {}),
            ...(input.cursor
              ? {
                  AND: [
                    {
                      OR: [
                        { createdAt: { lt: cursorDate! } },
                        { createdAt: cursorDate!, id: { lt: input.cursor.id } },
                      ],
                    },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            createdAt: true,
            memberships: {
              where: { status: 'ACTIVE', role: 'OWNER' },
              take: 1,
              select: { user: { select: { email: true } } },
            },
            _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
          },
        }),
      )
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
