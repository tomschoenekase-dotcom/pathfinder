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
import { mediaFindingsSchema, paginateMediaFindings } from './media-ingestion-review-schemas'

const mediaIngestionAssetSelect = {
  id: true,
  sourceId: true,
  filename: true,
  mediaType: true,
  bytes: true,
  status: true,
  error: true,
  updatedAt: true,
} as const

function serializeAsset<T extends { bytes: bigint }>(
  asset: T,
): Omit<T, 'bytes'> & { bytes: number } {
  const { bytes, ...rest } = asset
  return { ...rest, bytes: Number(bytes) }
}

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
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        projectId: z.string().min(1),
      }),
    )
    .query(async ({ input }) => {
      const row = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: { id: input.projectId, tenantId: input.tenantId, venueId: input.venueId },
          select: {
            ...projectSelect,
            sourceObjectKey: true,
            sourceObjectGeneration: true,
          },
        }),
      )
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Media project not found.' })
      const { sourceObjectKey, sourceObjectGeneration, ...project } = row
      const findingsPage = paginateMediaFindings(mediaFindingsSchema.parse(project.findings))!
      const assets = sourceObjectKey
        ? await withTenantIsolationBypass(() =>
            db.mediaIngestionAsset.findMany({
              where: {
                tenantId: input.tenantId,
                projectId: input.projectId,
                objectKey: { startsWith: `${sourceObjectKey}#` },
              },
              orderBy: [{ filename: 'asc' }, { id: 'asc' }],
              take: 51,
              select: mediaIngestionAssetSelect,
            }),
          )
        : []
      return {
        ...serializeProject(project),
        findings: findingsPage.items,
        findingsNextCursor: findingsPage.nextCursor,
        reviewGeneration: sourceObjectGeneration,
        assets: assets.slice(0, 50).map(serializeAsset),
        assetsTruncated: assets.length > 50,
      }
    }),

  listFindings: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        projectId: z.string().min(1),
        reviewGeneration: z.string().uuid().nullable(),
        cursor: z.string().min(1).max(500).optional(),
      }),
    )
    .query(async ({ input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: { id: input.projectId, tenantId: input.tenantId, venueId: input.venueId },
          select: { findings: true, sourceObjectGeneration: true },
        }),
      )
      if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Media project not found.' })
      if (project.sourceObjectGeneration !== input.reviewGeneration) {
        throw new TRPCError({ code: 'CONFLICT', message: 'The media source generation changed.' })
      }
      const page = paginateMediaFindings(mediaFindingsSchema.parse(project.findings), input.cursor)
      if (!page) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid source finding cursor.' })
      }
      return page
    }),

  status: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        projectId: z.string().min(1),
      }),
    )
    .query(async ({ input }) => {
      const row = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: { id: input.projectId, tenantId: input.tenantId, venueId: input.venueId },
          select: {
            id: true,
            venueId: true,
            status: true,
            stage: true,
            progress: true,
            coverage: true,
            error: true,
            updatedAt: true,
            completedAt: true,
            sourceObjectGeneration: true,
          },
        }),
      )
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Media project not found.' })
      return {
        id: row.id,
        venueId: row.venueId,
        reviewGeneration: row.sourceObjectGeneration,
        status: row.status,
        stage: row.stage,
        progress: row.progress,
        coverage: row.coverage,
        error: row.error,
        updatedAt: row.updatedAt,
        completedAt: row.completedAt,
        hasDraft: row.status === 'NEEDS_INPUT' || row.status === 'READY_FOR_REVIEW',
      }
    }),

  listAssets: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        projectId: z.string().min(1),
        reviewGeneration: z.string().uuid().nullable(),
        cursor: z.string().cuid().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: { id: input.projectId, tenantId: input.tenantId, venueId: input.venueId },
          select: { sourceObjectKey: true, sourceObjectGeneration: true },
        }),
      )
      if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Media project not found.' })
      if (project.sourceObjectGeneration !== input.reviewGeneration) {
        throw new TRPCError({ code: 'CONFLICT', message: 'The media source generation changed.' })
      }
      if (!project.sourceObjectKey) return { items: [], nextCursor: null }
      const assetScope = {
        tenantId: input.tenantId,
        projectId: input.projectId,
        objectKey: { startsWith: `${project.sourceObjectKey}#` },
      } as const
      const cursor = input.cursor
      const cursorAsset = cursor
        ? await withTenantIsolationBypass(() =>
            db.mediaIngestionAsset.findFirst({
              where: { ...assetScope, id: cursor },
              select: { id: true, filename: true },
            }),
          )
        : null
      if (cursor && !cursorAsset) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid source evidence cursor.' })
      }
      const rows = await withTenantIsolationBypass(() =>
        db.mediaIngestionAsset.findMany({
          where: {
            ...assetScope,
            ...(cursorAsset
              ? {
                  OR: [
                    { filename: { gt: cursorAsset.filename } },
                    { filename: cursorAsset.filename, id: { gt: cursorAsset.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ filename: 'asc' }, { id: 'asc' }],
          take: input.limit + 1,
          select: mediaIngestionAssetSelect,
        }),
      )
      const hasMore = rows.length > input.limit
      const items = rows.slice(0, input.limit)
      return {
        items: items.map(serializeAsset),
        nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      }
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
