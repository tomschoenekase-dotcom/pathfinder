import { z } from 'zod'

export const adminOsSearchInput = z
  .object({
    query: z.string().trim().min(1).max(100),
    limitPerGroup: z.number().int().min(1).max(10).default(5),
    group: z
      .enum([
        'clients',
        'venues',
        'content',
        'support',
        'agents',
        'jobs',
        'packages',
        'evaluations',
      ])
      .optional(),
    cursor: z
      .object({ createdAt: z.string().datetime({ offset: true }), id: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.cursor === undefined || value.group !== undefined, {
    message: 'A cursor requires one result group',
    path: ['cursor'],
  })

export const clientDirectorySearchInput = z
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
  .strict()
