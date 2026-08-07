import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass, writeAuditLog } from '@pathfinder/db'
import { enqueueMediaIngestion } from '@pathfinder/jobs'

import { router } from '../../core'
import { currentDeploymentStorageKey } from '../../lib/deployment-storage-key'
import { beginMediaUpload, finishMediaUpload, signMediaUploadPart } from '../../lib/media-storage'
import { adminProcedure } from '../../trpc'

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024
const modes = ['ECONOMY', 'BALANCED', 'FORENSIC'] as const

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-180)
}

const projectSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  name: true,
  context: true,
  mode: true,
  status: true,
  stage: true,
  progress: true,
  sourceFileName: true,
  sourceBytes: true,
  settings: true,
  coverage: true,
  questions: true,
  findings: true,
  draftJson: true,
  estimatedCostCents: true,
  actualCostCents: true,
  error: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
} as const

function serializeProject<T extends { sourceBytes: bigint | null }>(row: T) {
  return { ...row, sourceBytes: row.sourceBytes === null ? null : Number(row.sourceBytes) }
}

export const mediaIngestionRouter = router({
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

  beginUpload: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        filename: z.string().trim().min(1).max(255),
        bytes: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
        contentType: z.enum(['application/zip', 'application/x-zip-compressed']),
      }),
    )
    .mutation(async ({ input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: { id: input.projectId, tenantId: input.tenantId },
          select: { id: true, venueId: true, status: true },
        }),
      )
      if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Media project not found.' })
      if (!['DRAFT', 'FAILED'].includes(project.status)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This project already has an upload.' })
      }
      const objectKey = currentDeploymentStorageKey(
        `media-ingestion/${input.tenantId}/${project.venueId}/${project.id}/${safeFileName(input.filename)}`,
      )
      const reserved = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: {
            id: project.id,
            tenantId: input.tenantId,
            status: { in: ['DRAFT', 'FAILED'] },
          },
          data: {
            status: 'UPLOADING',
            stage: 'upload',
            sourceObjectKey: objectKey,
            sourceFileName: input.filename,
            sourceBytes: BigInt(input.bytes),
            error: null,
          },
        }),
      )
      if (reserved.count !== 1) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This project already has an upload.' })
      }
      try {
        return await beginMediaUpload(objectKey, input.contentType)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Media upload creation failed.'
        await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.updateMany({
            where: { id: project.id, tenantId: input.tenantId, status: 'UPLOADING' },
            data: { status: 'FAILED', stage: 'upload', error: message },
          }),
        )
        throw error
      }
    }),

  signPart: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        uploadId: z.string().min(1),
        partNumber: z.number().int().min(1).max(10_000),
      }),
    )
    .mutation(async ({ input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: { id: input.projectId, tenantId: input.tenantId, status: 'UPLOADING' },
          select: { sourceObjectKey: true },
        }),
      )
      if (!project?.sourceObjectKey) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active upload not found.' })
      }
      return {
        url: await signMediaUploadPart(project.sourceObjectKey, input.uploadId, input.partNumber),
      }
    }),

  completeUpload: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        uploadId: z.string().min(1),
        parts: z
          .array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }))
          .min(1)
          .max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: { id: input.projectId, tenantId: input.tenantId, status: 'UPLOADING' },
          select: { id: true, sourceObjectKey: true },
        }),
      )
      if (!project?.sourceObjectKey) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active upload not found.' })
      }
      await finishMediaUpload(project.sourceObjectKey, input.uploadId, input.parts)
      await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: { id: project.id, tenantId: input.tenantId },
          data: { status: 'QUEUED', stage: 'inventory', progress: 1 },
        }),
      )
      const queued = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: { id: project.id, tenantId: input.tenantId },
          select: { venueId: true },
        }),
      )
      if (!queued) throw new TRPCError({ code: 'NOT_FOUND', message: 'Media project not found.' })
      try {
        await enqueueMediaIngestion({
          tenantId: input.tenantId,
          venueId: queued.venueId,
          projectId: project.id,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Media ingestion enqueue failed.'
        await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.updateMany({
            where: { id: project.id, tenantId: input.tenantId, status: 'QUEUED' },
            data: { status: 'FAILED', stage: 'queue', error: message },
          }),
        )
        throw error
      }
      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.media_ingestion.upload_completed',
        targetType: 'MediaIngestionProject',
        targetId: project.id,
      })
      return { ok: true }
    }),

  saveReview: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        questions: z.array(z.record(z.unknown())).max(500),
        draftJson: z.record(z.unknown()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: { id: input.projectId, tenantId: input.tenantId },
          data: {
            questions: input.questions,
            draftJson: input.draftJson,
            status: 'READY_FOR_REVIEW',
            stage: 'review',
          },
        }),
      )
      if (result.count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Media project not found.' })
      }
      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.media_ingestion.review_saved',
        targetType: 'MediaIngestionProject',
        targetId: input.projectId,
      })
      return { ok: true }
    }),
})
