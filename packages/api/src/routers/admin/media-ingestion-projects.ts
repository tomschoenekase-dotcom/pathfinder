import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass, writeAuditLog } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  mediaIngestionModes as modes,
  mediaIngestionProjectSelect as projectSelect,
  serializeMediaIngestionProject as serializeProject,
} from './media-ingestion-helpers'

export const mediaIngestionProjectsRouter = router({
  list: adminProcedure
    .input(z.object({ tenantId: z.string().min(1), venueId: z.string().min(1) }))
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const rows = await db.mediaIngestionProject.findMany({
          where: { tenantId: input.tenantId, venueId: input.venueId },
          orderBy: { createdAt: 'desc' },
          select: projectSelect,
        })
        return rows.map(serializeProject)
      }),
    ),

  get: adminProcedure
    .input(z.object({ tenantId: z.string().min(1), projectId: z.string().min(1) }))
    .query(async ({ input }) => {
      const row = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: { id: input.projectId, tenantId: input.tenantId },
          select: projectSelect,
        }),
      )
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Media project not found.' })
      return serializeProject(row)
    }),

  create: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        name: z.string().trim().min(1).max(160),
        context: z.string().max(30_000).default(''),
        mode: z.enum(modes).default('BALANCED'),
        settings: z
          .object({
            transcribeAudio: z.boolean().default(true),
            preserveVerbatimText: z.boolean().default(true),
            detectDuplicates: z.boolean().default(true),
            requireEveryImage: z.boolean().default(true),
            videoSecondsPerSample: z.number().int().min(1).max(60).default(8),
          })
          .default({}),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found.' })
        return db.mediaIngestionProject.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            name: input.name,
            context: input.context,
            mode: input.mode,
            settings: input.settings,
            createdBy: ctx.session.userId,
          },
          select: { id: true },
        })
      })
      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.media_ingestion.created',
        targetType: 'MediaIngestionProject',
        targetId: project.id,
      })
      return project
    }),
})
