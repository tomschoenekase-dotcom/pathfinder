import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminClientSearchRouter = router({
  searchAdminOs: adminProcedure
    .input(
      z
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
        }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const take = input.limitPerGroup + 1
        const cursorDate = input.cursor ? new Date(input.cursor.createdAt) : null
        const cursor = input.cursor
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
          : {}
        const includes = (group: NonNullable<typeof input.group>) =>
          !input.group || input.group === group
        const [clients, venues, content, support, agents, jobs, packages, evaluations] =
          await Promise.all([
            includes('clients')
              ? db.tenant.findMany({
                  where: {
                    OR: [
                      { name: { contains: input.query, mode: 'insensitive' } },
                      { slug: { contains: input.query, mode: 'insensitive' } },
                    ],
                    ...cursor,
                  },
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  take,
                  select: { id: true, name: true, slug: true, status: true, createdAt: true },
                })
              : [],
            includes('venues')
              ? db.venue.findMany({
                  where: {
                    OR: [
                      { name: { contains: input.query, mode: 'insensitive' } },
                      { slug: { contains: input.query, mode: 'insensitive' } },
                      { category: { contains: input.query, mode: 'insensitive' } },
                    ],
                    ...cursor,
                  },
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  take,
                  select: {
                    id: true,
                    tenantId: true,
                    name: true,
                    slug: true,
                    category: true,
                    isActive: true,
                    createdAt: true,
                  },
                })
              : [],
            includes('content')
              ? db.contentModuleRevision.findMany({
                  where: {
                    OR: [
                      { moduleId: { contains: input.query, mode: 'insensitive' } },
                      {
                        service: {
                          is: {
                            OR: [
                              { name: { contains: input.query, mode: 'insensitive' } },
                              { description: { contains: input.query, mode: 'insensitive' } },
                            ],
                          },
                        },
                      },
                      {
                        policy: {
                          is: {
                            OR: [
                              { title: { contains: input.query, mode: 'insensitive' } },
                              { rule: { contains: input.query, mode: 'insensitive' } },
                            ],
                          },
                        },
                      },
                      {
                        event: {
                          is: {
                            OR: [
                              { name: { contains: input.query, mode: 'insensitive' } },
                              { description: { contains: input.query, mode: 'insensitive' } },
                            ],
                          },
                        },
                      },
                      {
                        operationalFact: {
                          is: {
                            OR: [
                              { label: { contains: input.query, mode: 'insensitive' } },
                              { value: { contains: input.query, mode: 'insensitive' } },
                            ],
                          },
                        },
                      },
                      {
                        relationship: {
                          is: {
                            OR: [
                              { relationshipType: { contains: input.query, mode: 'insensitive' } },
                              { description: { contains: input.query, mode: 'insensitive' } },
                            ],
                          },
                        },
                      },
                    ],
                    ...cursor,
                  },
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  take,
                  select: {
                    id: true,
                    tenantId: true,
                    venueId: true,
                    moduleId: true,
                    kind: true,
                    version: true,
                    audience: true,
                    createdAt: true,
                    service: { select: { name: true } },
                    policy: { select: { title: true } },
                    event: { select: { name: true } },
                    operationalFact: { select: { label: true } },
                    relationship: { select: { relationshipType: true } },
                  },
                })
              : [],
            includes('support')
              ? db.supportRequest.findMany({
                  where: {
                    OR: [
                      { subject: { contains: input.query, mode: 'insensitive' } },
                      { id: { contains: input.query, mode: 'insensitive' } },
                    ],
                    ...cursor,
                  },
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  take,
                  select: {
                    id: true,
                    tenantId: true,
                    venueId: true,
                    subject: true,
                    category: true,
                    status: true,
                    createdAt: true,
                  },
                })
              : [],
            includes('agents')
              ? db.agentRun.findMany({
                  where: {
                    OR: [
                      { requestedOperation: { contains: input.query, mode: 'insensitive' } },
                      { runType: { contains: input.query, mode: 'insensitive' } },
                      { id: { contains: input.query, mode: 'insensitive' } },
                    ],
                    ...cursor,
                  },
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  take,
                  select: {
                    id: true,
                    tenantId: true,
                    venueId: true,
                    runType: true,
                    requestedOperation: true,
                    status: true,
                    createdAt: true,
                  },
                })
              : [],
            includes('jobs')
              ? db.jobRecord.findMany({
                  where: {
                    OR: [
                      { jobName: { contains: input.query, mode: 'insensitive' } },
                      { bullJobId: { contains: input.query, mode: 'insensitive' } },
                    ],
                    ...cursor,
                  },
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  take,
                  select: {
                    id: true,
                    tenantId: true,
                    queue: true,
                    jobName: true,
                    bullJobId: true,
                    status: true,
                    createdAt: true,
                  },
                })
              : [],
            includes('packages')
              ? db.venuePackage.findMany({
                  where: {
                    OR: [
                      { id: { contains: input.query, mode: 'insensitive' } },
                      { payloadHash: { contains: input.query, mode: 'insensitive' } },
                    ],
                    ...cursor,
                  },
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  take,
                  select: {
                    id: true,
                    tenantId: true,
                    venueId: true,
                    schemaVersion: true,
                    status: true,
                    payloadHash: true,
                    createdAt: true,
                  },
                })
              : [],
            includes('evaluations')
              ? db.evalRun.findMany({
                  where: {
                    OR: [
                      { idempotencyKey: { contains: input.query, mode: 'insensitive' } },
                      { modelName: { contains: input.query, mode: 'insensitive' } },
                    ],
                    ...cursor,
                  },
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  take,
                  select: {
                    id: true,
                    tenantId: true,
                    venueId: true,
                    idempotencyKey: true,
                    modelProvider: true,
                    modelName: true,
                    triggerType: true,
                    createdAt: true,
                  },
                })
              : [],
          ])
        const makeGroup = <T extends { id: string; createdAt: Date }>(
          name: string,
          rows: T[],
          map: (row: T) => {
            id: string
            tenantId: string | null
            venueId: string | null
            label: string
            detail: string
            route: string
          },
        ) => {
          const page = rows.slice(0, input.limitPerGroup)
          const last = page.at(-1)
          return {
            name,
            items: page.map((row) => ({ ...map(row), createdAt: row.createdAt })),
            nextCursor:
              rows.length > input.limitPerGroup && last
                ? { createdAt: last.createdAt.toISOString(), id: last.id }
                : null,
          }
        }
        return {
          groups: [
            makeGroup('clients', clients, (row) => ({
              id: row.id,
              tenantId: row.id,
              venueId: null,
              label: row.name,
              detail: `${row.slug} · ${row.status}`,
              route: `/admin/clients/${row.id}`,
            })),
            makeGroup('venues', venues, (row) => ({
              id: row.id,
              tenantId: row.tenantId,
              venueId: row.id,
              label: row.name,
              detail: `${row.category ?? 'Venue'} · ${row.isActive ? 'active' : 'inactive'}`,
              route: `/admin/clients/${row.tenantId}/venues/${row.id}`,
            })),
            makeGroup('content', content, (row) => ({
              id: row.id,
              tenantId: row.tenantId,
              venueId: row.venueId,
              label:
                row.service?.name ??
                row.policy?.title ??
                row.event?.name ??
                row.operationalFact?.label ??
                row.relationship?.relationshipType ??
                row.moduleId,
              detail: `${row.kind} · v${row.version} · ${row.audience}`,
              route: `/admin/clients/${row.tenantId}/venues/${row.venueId}/content`,
            })),
            makeGroup('support', support, (row) => ({
              id: row.id,
              tenantId: row.tenantId,
              venueId: row.venueId,
              label: row.subject,
              detail: `${row.category} · ${row.status}`,
              route: `/admin/clients/${row.tenantId}/venues/${row.venueId}/support-operations`,
            })),
            makeGroup('agents', agents, (row) => ({
              id: row.id,
              tenantId: row.tenantId,
              venueId: row.venueId,
              label: row.requestedOperation,
              detail: `${row.runType} · ${row.status}`,
              route: row.venueId
                ? `/admin/clients/${row.tenantId}/venues/${row.venueId}/agents/runs/${row.id}`
                : `/admin/clients/${row.tenantId}`,
            })),
            makeGroup('jobs', jobs, (row) => ({
              id: row.id,
              tenantId: row.tenantId,
              venueId: null,
              label: row.jobName,
              detail: `${row.queue} · ${row.status}`,
              route: row.tenantId ? `/admin/clients/${row.tenantId}` : '/admin',
            })),
            makeGroup('packages', packages, (row) => ({
              id: row.id,
              tenantId: row.tenantId,
              venueId: row.venueId,
              label: `Package ${row.id}`,
              detail: `schema ${row.schemaVersion} · ${row.status}`,
              route: `/admin/clients/${row.tenantId}/venues/${row.venueId}/content`,
            })),
            makeGroup('evaluations', evaluations, (row) => ({
              id: row.id,
              tenantId: row.tenantId,
              venueId: row.venueId,
              label: row.idempotencyKey,
              detail: `${row.modelProvider}/${row.modelName} · ${row.triggerType}`,
              route: `/admin/clients/${row.tenantId}/venues/${row.venueId}/evaluations`,
            })),
          ].filter((group) => !input.group || group.name === input.group),
        }
      }),
    ),
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
