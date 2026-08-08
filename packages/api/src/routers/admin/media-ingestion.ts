import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { logger } from '@pathfinder/config'
import { db, withTenantIsolationBypass, writeAuditLog } from '@pathfinder/db'
import { enqueueMediaIngestion } from '@pathfinder/jobs'

import { router } from '../../core'
import { currentDeploymentStorageKey } from '../../lib/deployment-storage-key'
import {
  abortMediaUpload,
  beginMediaUpload,
  finishMediaUpload,
  MEDIA_UPLOAD_PART_SIZE,
  mediaUploadPartCount,
  normalizeMediaUploadParts,
  signMediaUploadPart,
} from '../../lib/media-storage'
import { adminProcedure } from '../../trpc'

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024
const modes = ['ECONOMY', 'BALANCED', 'FORENSIC'] as const

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-180)
}

function isNoSuchUpload(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown }
  return (
    candidate.name === 'NoSuchUpload' ||
    candidate.Code === 'NoSuchUpload' ||
    candidate.code === 'NoSuchUpload'
  )
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
  uploadAttemptId: true,
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
        uploadAttemptId: z.string().uuid(),
        filename: z.string().trim().min(1).max(255),
        bytes: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
        contentType: z.enum(['application/zip', 'application/x-zip-compressed']),
      }),
    )
    .mutation(async ({ input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: { id: input.projectId, tenantId: input.tenantId },
          select: {
            id: true,
            venueId: true,
            status: true,
            stage: true,
            sourceFileName: true,
            sourceBytes: true,
            sourceContentType: true,
            uploadAttemptId: true,
            storageUploadId: true,
          },
        }),
      )
      if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Media project not found.' })
      if (
        project.status === 'UPLOADING' &&
        project.stage === 'upload' &&
        project.uploadAttemptId === input.uploadAttemptId &&
        project.sourceFileName === input.filename &&
        project.sourceBytes === BigInt(input.bytes) &&
        project.sourceContentType === input.contentType &&
        project.storageUploadId
      ) {
        return { partSize: MEDIA_UPLOAD_PART_SIZE }
      }
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
            stage: 'creating-upload',
            sourceObjectKey: objectKey,
            sourceFileName: input.filename,
            sourceBytes: BigInt(input.bytes),
            sourceContentType: input.contentType,
            uploadAttemptId: input.uploadAttemptId,
            uploadStartedAt: new Date(),
            storageUploadId: null,
            error: null,
          },
        }),
      )
      if (reserved.count !== 1) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This project already has an upload.' })
      }
      let started: Awaited<ReturnType<typeof beginMediaUpload>>
      try {
        started = await beginMediaUpload(objectKey, input.contentType)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Media upload creation failed.'
        try {
          const compensated = await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.updateMany({
              where: {
                id: project.id,
                tenantId: input.tenantId,
                status: 'UPLOADING',
                stage: 'creating-upload',
                uploadAttemptId: input.uploadAttemptId,
              },
              data: {
                status: 'FAILED',
                stage: 'upload',
                error: message,
                uploadAttemptId: null,
                uploadStartedAt: null,
                storageUploadId: null,
                sourceContentType: null,
              },
            }),
          )
          if (compensated.count !== 1) {
            logger.warn({
              action: 'media-ingestion.upload-creation-compensation.missed',
              projectId: project.id,
              uploadAttemptId: input.uploadAttemptId,
            })
          }
        } catch (compensationError) {
          logger.warn({
            action: 'media-ingestion.upload-creation-compensation.failed',
            projectId: project.id,
            uploadAttemptId: input.uploadAttemptId,
            error:
              compensationError instanceof Error
                ? compensationError.message
                : 'Unknown compensation error',
          })
        }
        throw error
      }
      let persistenceError: unknown
      try {
        const persisted = await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.updateMany({
            where: {
              id: project.id,
              tenantId: input.tenantId,
              status: 'UPLOADING',
              stage: 'creating-upload',
              uploadAttemptId: input.uploadAttemptId,
            },
            data: { stage: 'upload', storageUploadId: started.uploadId },
          }),
        )
        if (persisted.count !== 1) {
          persistenceError = new Error(
            'The media upload generation claim was lost before persistence.',
          )
        }
      } catch (error) {
        try {
          const readback = await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.findFirst({
              where: {
                id: project.id,
                tenantId: input.tenantId,
                status: 'UPLOADING',
                uploadAttemptId: input.uploadAttemptId,
              },
              select: { stage: true, storageUploadId: true },
            }),
          )
          if (readback?.stage === 'upload' && readback.storageUploadId === started.uploadId) {
            return { partSize: started.partSize }
          }
        } catch (readbackError) {
          logger.warn({
            action: 'media-ingestion.upload-identity-persistence.uncertain',
            projectId: project.id,
            uploadAttemptId: input.uploadAttemptId,
            error: 'Upload identity persistence could not be confirmed.',
            errorType: readbackError instanceof Error ? readbackError.name : 'UnknownError',
          })
          throw error
        }
        logger.warn({
          action: 'media-ingestion.upload-identity-persistence.uncertain',
          projectId: project.id,
          uploadAttemptId: input.uploadAttemptId,
          error: 'Upload identity persistence could not be confirmed.',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        })
        throw error
      }
      if (persistenceError !== undefined) {
        try {
          await abortMediaUpload(objectKey, started.uploadId)
        } catch (abortError) {
          logger.warn({
            action: 'media-ingestion.upload-creation-abort.failed',
            projectId: project.id,
            uploadAttemptId: input.uploadAttemptId,
            error: 'Newly created multipart upload abort failed.',
            errorType: abortError instanceof Error ? abortError.name : 'UnknownError',
          })
        }
        const message = 'Upload identity persistence failed.'
        try {
          const compensated = await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.updateMany({
              where: {
                id: project.id,
                tenantId: input.tenantId,
                status: 'UPLOADING',
                stage: 'creating-upload',
                uploadAttemptId: input.uploadAttemptId,
              },
              data: {
                status: 'FAILED',
                stage: 'upload',
                error: message,
                uploadAttemptId: null,
                uploadStartedAt: null,
                storageUploadId: null,
                sourceContentType: null,
              },
            }),
          )
          if (compensated.count !== 1) {
            logger.warn({
              action: 'media-ingestion.upload-identity-compensation.missed',
              projectId: project.id,
              uploadAttemptId: input.uploadAttemptId,
            })
          }
        } catch (compensationError) {
          logger.warn({
            action: 'media-ingestion.upload-identity-compensation.failed',
            projectId: project.id,
            uploadAttemptId: input.uploadAttemptId,
            error: 'Upload identity compensation failed.',
            errorType: compensationError instanceof Error ? compensationError.name : 'UnknownError',
          })
        }
        throw persistenceError
      }
      return { partSize: started.partSize }
    }),

  signPart: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        uploadAttemptId: z.string().uuid(),
        partNumber: z.number().int().min(1).max(10_000),
      }),
    )
    .mutation(async ({ input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            status: 'UPLOADING',
            stage: 'upload',
            uploadAttemptId: input.uploadAttemptId,
          },
          select: { sourceObjectKey: true, sourceBytes: true, storageUploadId: true },
        }),
      )
      if (!project?.sourceObjectKey || project.sourceBytes === null || !project.storageUploadId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active upload not found.' })
      }
      const expectedPartCount = mediaUploadPartCount(Number(project.sourceBytes))
      if (input.partNumber > expectedPartCount) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `This upload has only ${expectedPartCount} parts.`,
        })
      }
      return {
        url: await signMediaUploadPart(
          project.sourceObjectKey,
          project.storageUploadId,
          input.partNumber,
        ),
      }
    }),

  completeUpload: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        uploadAttemptId: z.string().uuid(),
        parts: z
          .array(
            z.object({
              partNumber: z.number().int().min(1).max(10_000),
              etag: z.string().min(1),
            }),
          )
          .min(1)
          .max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            status: 'UPLOADING',
            stage: 'upload',
            uploadAttemptId: input.uploadAttemptId,
          },
          select: {
            id: true,
            venueId: true,
            sourceObjectKey: true,
            sourceBytes: true,
            storageUploadId: true,
          },
        }),
      )
      if (!project?.sourceObjectKey || project.sourceBytes === null || !project.storageUploadId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active upload not found.' })
      }
      const expectedBytes = Number(project.sourceBytes)
      let parts: Array<{ partNumber: number; etag: string }>
      try {
        parts = normalizeMediaUploadParts(input.parts, mediaUploadPartCount(expectedBytes))
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid media upload parts.',
          cause: error,
        })
      }
      const claimed = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: {
            id: project.id,
            tenantId: input.tenantId,
            status: 'UPLOADING',
            stage: 'upload',
            uploadAttemptId: input.uploadAttemptId,
          },
          data: { stage: 'finalizing', error: null },
        }),
      )
      if (claimed.count !== 1) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This upload is already being finalized.',
        })
      }
      let verifiedBytes: number
      try {
        const verified = await finishMediaUpload(
          project.sourceObjectKey,
          project.storageUploadId,
          parts,
          expectedBytes,
          MAX_ARCHIVE_BYTES,
        )
        verifiedBytes = verified.bytes
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Media upload completion failed.'
        try {
          const compensated = await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.updateMany({
              where: {
                id: project.id,
                tenantId: input.tenantId,
                status: 'UPLOADING',
                stage: 'finalizing',
                uploadAttemptId: input.uploadAttemptId,
              },
              data: { status: 'FAILED', stage: 'upload', error: message },
            }),
          )
          if (compensated.count !== 1) {
            logger.warn({
              action: 'media-ingestion.upload-finalization-compensation.missed',
              projectId: project.id,
              error: 'The finalization claim no longer matched.',
            })
          }
        } catch (compensationError) {
          logger.warn({
            action: 'media-ingestion.upload-finalization-compensation.failed',
            projectId: project.id,
            error:
              compensationError instanceof Error
                ? compensationError.message
                : 'Unknown compensation error',
          })
        }
        throw error
      }
      let transitionedCount: number | null = null
      let transitionError: unknown
      try {
        const transitioned = await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.updateMany({
            where: {
              id: project.id,
              tenantId: input.tenantId,
              status: 'UPLOADING',
              stage: 'finalizing',
              uploadAttemptId: input.uploadAttemptId,
            },
            data: {
              status: 'QUEUED',
              stage: 'inventory',
              progress: 1,
              sourceBytes: BigInt(verifiedBytes),
              uploadStartedAt: null,
              storageUploadId: null,
              sourceContentType: null,
            },
          }),
        )
        transitionedCount = transitioned.count
      } catch (error) {
        transitionError = error
      }
      if (transitionedCount !== 1) {
        let readback: { status: string; stage: string; sourceBytes: bigint | null } | null
        try {
          readback = await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.findFirst({
              where: {
                id: project.id,
                tenantId: input.tenantId,
                uploadAttemptId: input.uploadAttemptId,
              },
              select: { status: true, stage: true, sourceBytes: true },
            }),
          )
        } catch (readbackError) {
          logger.warn({
            action: 'media-ingestion.upload-queue-transition.uncertain',
            projectId: project.id,
            uploadAttemptId: input.uploadAttemptId,
            error: 'Upload queue transition could not be confirmed.',
            errorType: readbackError instanceof Error ? readbackError.name : 'UnknownError',
          })
          if (transitionError !== undefined) throw transitionError
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'The upload state changed before completion could be recorded.',
          })
        }
        const exactQueued =
          readback?.status === 'QUEUED' &&
          readback.stage === 'inventory' &&
          readback.sourceBytes === BigInt(verifiedBytes)
        const alreadyProcessing =
          readback !== null &&
          ['INVENTORYING', 'ANALYZING', 'SYNTHESIZING'].includes(readback.status)
        if (alreadyProcessing) return { ok: true }
        if (!exactQueued) {
          if (transitionError !== undefined) {
            logger.warn({
              action: 'media-ingestion.upload-queue-transition.uncertain',
              projectId: project.id,
              uploadAttemptId: input.uploadAttemptId,
              error: 'Upload queue transition could not be confirmed.',
              errorType: transitionError instanceof Error ? transitionError.name : 'UnknownError',
            })
            throw transitionError
          }
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'The upload state changed before completion could be recorded.',
          })
        }
      }
      try {
        await enqueueMediaIngestion({
          tenantId: input.tenantId,
          venueId: project.venueId,
          projectId: project.id,
          uploadAttemptId: input.uploadAttemptId,
        })
      } catch (error) {
        try {
          await withTenantIsolationBypass(() =>
            db.mediaIngestionProject.updateMany({
              where: {
                id: project.id,
                tenantId: input.tenantId,
                status: 'QUEUED',
                stage: 'inventory',
                uploadAttemptId: input.uploadAttemptId,
              },
              data: { error: 'Media ingestion enqueue could not be confirmed.' },
            }),
          )
        } catch (statusError) {
          logger.warn({
            action: 'media-ingestion.upload-enqueue-state.failed',
            projectId: project.id,
            uploadAttemptId: input.uploadAttemptId,
            error: 'Upload enqueue state could not be recorded.',
            errorType: statusError instanceof Error ? statusError.name : 'UnknownError',
          })
        }
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

  retryEnqueue: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        uploadAttemptId: z.string().uuid(),
      }),
    )
    .mutation(async ({ input }) => {
      const project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            status: 'QUEUED',
            stage: 'inventory',
            uploadAttemptId: input.uploadAttemptId,
          },
          select: { id: true, venueId: true },
        }),
      )
      if (!project) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Queued upload generation not found.' })
      }
      await enqueueMediaIngestion({
        tenantId: input.tenantId,
        venueId: project.venueId,
        projectId: project.id,
        uploadAttemptId: input.uploadAttemptId,
      })
      return { ok: true }
    }),

  abortUpload: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        projectId: z.string().min(1),
        uploadAttemptId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let project = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.findFirst({
          where: {
            id: input.projectId,
            tenantId: input.tenantId,
            status: 'UPLOADING',
            stage: 'upload',
            uploadAttemptId: input.uploadAttemptId,
          },
          select: { id: true, sourceObjectKey: true, storageUploadId: true },
        }),
      )
      let resumedAbort = false
      if (!project) {
        project = await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.findFirst({
            where: {
              id: input.projectId,
              tenantId: input.tenantId,
              status: 'UPLOADING',
              stage: 'aborting',
              uploadAttemptId: input.uploadAttemptId,
            },
            select: { id: true, sourceObjectKey: true, storageUploadId: true },
          }),
        )
        resumedAbort = project !== null
      }
      if (!project?.sourceObjectKey || !project.storageUploadId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active upload not found.' })
      }
      if (!resumedAbort) {
        const claimed = await withTenantIsolationBypass(() =>
          db.mediaIngestionProject.updateMany({
            where: {
              id: project.id,
              tenantId: input.tenantId,
              status: 'UPLOADING',
              stage: 'upload',
              uploadAttemptId: input.uploadAttemptId,
            },
            data: { stage: 'aborting', error: null },
          }),
        )
        if (claimed.count !== 1) {
          throw new TRPCError({ code: 'CONFLICT', message: 'The upload state already changed.' })
        }
      }
      try {
        await abortMediaUpload(project.sourceObjectKey, project.storageUploadId)
      } catch (error) {
        if (resumedAbort && isNoSuchUpload(error)) {
          // A prior abort succeeded but its terminal database write was lost.
        } else {
          try {
            const compensated = await withTenantIsolationBypass(() =>
              db.mediaIngestionProject.updateMany({
                where: {
                  id: project.id,
                  tenantId: input.tenantId,
                  status: 'UPLOADING',
                  stage: 'aborting',
                  uploadAttemptId: input.uploadAttemptId,
                },
                data: {
                  stage: 'aborting',
                  error: 'Media upload abort could not be confirmed.',
                },
              }),
            )
            if (compensated.count !== 1) {
              logger.warn({
                action: 'media-ingestion.upload-abort-compensation.missed',
                projectId: project.id,
                uploadAttemptId: input.uploadAttemptId,
              })
            }
          } catch (compensationError) {
            logger.warn({
              action: 'media-ingestion.upload-abort-compensation.failed',
              projectId: project.id,
              uploadAttemptId: input.uploadAttemptId,
              error: 'Upload abort state persistence failed.',
              errorType:
                compensationError instanceof Error ? compensationError.name : 'UnknownError',
            })
          }
          throw error
        }
      }
      const cancelled = await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: {
            id: project.id,
            tenantId: input.tenantId,
            status: 'UPLOADING',
            stage: 'aborting',
            uploadAttemptId: input.uploadAttemptId,
          },
          data: {
            status: 'CANCELLED',
            stage: 'cancelled',
            uploadAttemptId: null,
            uploadStartedAt: null,
            storageUploadId: null,
            sourceContentType: null,
            error: null,
          },
        }),
      )
      if (cancelled.count !== 1) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'The abort result could not be recorded.',
        })
      }
      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.media_ingestion.upload_aborted',
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
