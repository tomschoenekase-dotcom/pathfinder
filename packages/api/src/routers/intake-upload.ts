import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  IntakeUploadActionError,
  claimIntakeUploadVerificationAction,
  recordIntakeUploadPrecheckAction,
  recordRejectedIntakeUploadPrecheckAction,
  listIntakeUploadsAction,
  rejectIntakeUploadAction,
  renewIntakeUploadVerificationLeaseAction,
  releaseIntakeUploadVerificationAction,
  releaseIntakeUploadAuthoritativeVerificationAction,
  reserveIntakeUploadAction,
  settleIntakeUploadAuthoritativeVerificationAction,
  type IntakeUploadActor,
  bindIntakeUploadMultipartAction,
  cancelIntakeUploadMultipartAction,
  completeIntakeUploadMultipartAction,
  getIntakeUploadMultipartAction,
} from '@pathfinder/db'
import {
  INTAKE_UPLOAD_MULTIPART_PART_BYTES,
  INTAKE_UPLOAD_MULTIPART_THRESHOLD_BYTES,
  IntakeUploadCursor,
  IntakeUploadMimeType,
  IntakeUploadReserveRequest,
} from '@pathfinder/contracts/intake-upload'

import { publicTRPCError, router } from '../core'
import {
  createIntakeUploadObjectKey,
  deleteInvalidIntakeUploadVersion,
  inspectIntakeUpload,
  readIntakeUploadVersion,
  signIntakeUploadPut,
  abortIntakeUploadMultipart,
  beginIntakeUploadMultipart,
  completeIntakeUploadMultipart,
  listIntakeUploadMultipartParts,
  signIntakeUploadPart,
} from '../lib/intake-upload-storage'
import {
  configuredIntakeUploadMalwareScanner,
  verifyIntakeUploadBytes,
} from '../lib/intake-upload-byte-verifier'
import { tenantProcedure } from '../trpc'

const venueId = z.string().trim().min(1).max(191)
const uploadId = z.string().trim().min(1).max(191)
const claimId = z.string().uuid()
const checksumSha256 = z.string().regex(/^[a-f0-9]{64}$/u)

function actor(session: { userId: string; role: string | null }): IntakeUploadActor {
  if (!['STAFF', 'MANAGER', 'OWNER'].includes(session.role ?? '')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'A tenant role is required' })
  }
  return {
    type: 'HUMAN',
    id: session.userId,
    role: session.role as IntakeUploadActor['role'],
  }
}

function mapActionError(error: unknown): never {
  if (error instanceof IntakeUploadActionError) {
    throw publicTRPCError({
      code:
        error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'CONFLICT',
      message: error.message,
    })
  }
  throw error
}

function safeUpload(upload: {
  id: string
  status: string
  displayName: string
  fileName: string
  mimeType: string
  category: string
  byteSize: number
  rejectionCode: string | null
  intakeRunId: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: upload.id,
    status: upload.status,
    displayName: upload.displayName,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    category: upload.category,
    byteSize: upload.byteSize,
    rejectionCode: upload.rejectionCode,
    intakeRunId: upload.intakeRunId,
    createdAt: upload.createdAt,
    updatedAt: upload.updatedAt,
  }
}

const rejectionCodeByInspection = {
  generation: 'GENERATION_MISMATCH',
  bytes: 'SIZE_MISMATCH',
  mime: 'MIME_MISMATCH',
  checksum: 'HASH_MISMATCH',
} as const

async function runAuthoritativeVerification(input: {
  scope: {
    client: NonNullable<
      Parameters<typeof settleIntakeUploadAuthoritativeVerificationAction>[0]['client']
    >
    tenantId: string
    venueId: string
    uploadId: string
    actor: IntakeUploadActor
    claimId: string
  }
  target: {
    objectKey: string
    objectGeneration: string
    mimeType: string
    byteSize: number
    sha256: string
    storageVersionId: string | null
  }
}) {
  const scanner = configuredIntakeUploadMalwareScanner()
  if (!scanner || !input.target.storageVersionId) return null
  const bytes = await readIntakeUploadVersion({
    key: input.target.objectKey,
    versionId: input.target.storageVersionId,
  })
  const malware = await scanner.scan({
    bytes,
    expectedBytes: input.target.byteSize,
    expectedSha256: input.target.sha256,
  })
  return settleIntakeUploadAuthoritativeVerificationAction({
    ...input.scope,
    malware: {
      ...malware,
      engine: scanner.engine,
      engineVersion: scanner.engineVersion,
    },
  })
}

export const intakeUploadRouter = router({
  reserve: tenantProcedure
    .input(IntakeUploadReserveRequest.extend({ venueId }).strict())
    .mutation(async ({ ctx, input }) => {
      const { venueId: scopedVenueId, ...request } = input
      try {
        // The durable identity must exist before any storage URL is minted.
        const reserved = await reserveIntakeUploadAction({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: scopedVenueId,
          actor: actor(ctx.session),
          request,
          trustedObjectIdentity: {
            objectKey: createIntakeUploadObjectKey(),
            objectGeneration: randomUUID(),
          },
        })
        if (reserved.nextAction !== 'UPLOAD_BYTES') {
          return {
            upload: safeUpload(reserved.upload),
            replayed: reserved.replayed,
            nextAction: reserved.nextAction,
            uploadRequest: null,
          }
        }
        if (reserved.uploadTarget.byteSize > INTAKE_UPLOAD_MULTIPART_THRESHOLD_BYTES) {
          let target = reserved.uploadTarget
          if (!target.multipartUploadId) {
            const started = await beginIntakeUploadMultipart({
              key: target.objectKey,
              generation: target.objectGeneration,
              contentType: target.mimeType,
            })
            try {
              const bound = await bindIntakeUploadMultipartAction({
                client: ctx.db,
                tenantId: ctx.session.activeTenantId,
                venueId: scopedVenueId,
                uploadId: reserved.upload.id,
                multipartUploadId: started.uploadId,
                actor: actor(ctx.session),
              })
              target = {
                ...target,
                multipartUploadId: bound.upload.multipartUploadId,
                multipartStartedAt: bound.upload.multipartStartedAt,
              }
            } catch (error) {
              await abortIntakeUploadMultipart({
                key: target.objectKey,
                uploadId: started.uploadId,
              }).catch(() => undefined)
              const active = await getIntakeUploadMultipartAction({
                client: ctx.db,
                tenantId: ctx.session.activeTenantId,
                venueId: scopedVenueId,
                uploadId: reserved.upload.id,
                actor: actor(ctx.session),
              })
              target = { ...target, ...active.target }
              if (!target.multipartUploadId) throw error
            }
          }
          if (!target.multipartUploadId)
            throw new IntakeUploadActionError('CONFLICT', 'Multipart upload was not retained')
          const completedParts = await listIntakeUploadMultipartParts({
            key: target.objectKey,
            uploadId: target.multipartUploadId,
            expectedBytes: target.byteSize,
          })
          return {
            upload: safeUpload(reserved.upload),
            replayed: reserved.replayed,
            nextAction: reserved.nextAction,
            uploadRequest: {
              kind: 'multipart' as const,
              partSize: INTAKE_UPLOAD_MULTIPART_PART_BYTES,
              partCount: Math.ceil(target.byteSize / INTAKE_UPLOAD_MULTIPART_PART_BYTES),
              completedParts: completedParts.map((part) => ({
                partNumber: part.partNumber,
                etag: part.etag,
                checksumSha256: part.checksumSha256,
                size: part.size,
              })),
            },
          }
        }
        const signed = await signIntakeUploadPut({
          key: reserved.uploadTarget.objectKey,
          generation: reserved.uploadTarget.objectGeneration,
          contentType: reserved.uploadTarget.mimeType,
          bytes: reserved.uploadTarget.byteSize,
          checksumSha256: reserved.uploadTarget.sha256,
        })
        return {
          upload: safeUpload(reserved.upload),
          replayed: reserved.replayed,
          nextAction: reserved.nextAction,
          uploadRequest: { kind: 'single' as const, ...signed },
        }
      } catch (error) {
        mapActionError(error)
      }
    }),

  signMultipartPart: tenantProcedure
    .input(
      z
        .object({
          venueId,
          uploadId,
          partNumber: z.number().int().min(1).max(10_000),
          checksumSha256,
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const active = await getIntakeUploadMultipartAction({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          uploadId: input.uploadId,
          actor: actor(ctx.session),
        })
        const expectedParts = Math.ceil(active.target.byteSize / INTAKE_UPLOAD_MULTIPART_PART_BYTES)
        if (input.partNumber > expectedParts)
          throw new IntakeUploadActionError('INVALID_INPUT', 'Multipart part is out of range')
        return signIntakeUploadPart({
          key: active.target.objectKey,
          uploadId: active.target.multipartUploadId,
          partNumber: input.partNumber,
          checksumSha256: input.checksumSha256,
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  completeMultipart: tenantProcedure
    .input(z.object({ venueId, uploadId }).strict())
    .mutation(async ({ ctx, input }) => {
      const actionActor = actor(ctx.session)
      try {
        const active = await getIntakeUploadMultipartAction({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          uploadId: input.uploadId,
          actor: actionActor,
          allowCompleted: true,
        })
        if (!active.target.multipartCompletedAt) {
          try {
            const parts = await listIntakeUploadMultipartParts({
              key: active.target.objectKey,
              uploadId: active.target.multipartUploadId,
              expectedBytes: active.target.byteSize,
            })
            const expectedParts = Math.ceil(
              active.target.byteSize / INTAKE_UPLOAD_MULTIPART_PART_BYTES,
            )
            if (parts.length !== expectedParts)
              throw new IntakeUploadActionError(
                'CONFLICT',
                `Multipart upload has ${parts.length} of ${expectedParts} parts`,
              )
            await completeIntakeUploadMultipart({
              key: active.target.objectKey,
              uploadId: active.target.multipartUploadId,
              parts,
            })
          } catch (cause) {
            const inspection = await inspectIntakeUpload({
              key: active.target.objectKey,
              generation: active.target.objectGeneration,
              contentType: active.target.mimeType,
              bytes: active.target.byteSize,
              checksumSha256: active.target.sha256,
            }).catch(() => null)
            if (inspection?.state !== 'verified') {
              if (cause instanceof IntakeUploadActionError) throw cause
              throw publicTRPCError({
                code: 'SERVICE_UNAVAILABLE',
                message: 'Multipart completion could not be confirmed. Retry without re-uploading.',
                cause,
              })
            }
          }
        }
        const completed = await completeIntakeUploadMultipartAction({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          uploadId: input.uploadId,
          multipartUploadId: active.target.multipartUploadId,
          actor: actionActor,
        })
        return {
          upload: safeUpload(completed.upload),
          replayed: completed.replayed,
          nextAction: 'VERIFY' as const,
        }
      } catch (error) {
        mapActionError(error)
      }
    }),

  cancelMultipart: tenantProcedure
    .input(z.object({ venueId, uploadId }).strict())
    .mutation(async ({ ctx, input }) => {
      const actionActor = actor(ctx.session)
      try {
        const active = await getIntakeUploadMultipartAction({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          uploadId: input.uploadId,
          actor: actionActor,
          allowCancelled: true,
        })
        if (!active.target.multipartAbortedAt)
          await abortIntakeUploadMultipart({
            key: active.target.objectKey,
            uploadId: active.target.multipartUploadId,
          })
        const cancelled = await cancelIntakeUploadMultipartAction({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          uploadId: input.uploadId,
          multipartUploadId: active.target.multipartUploadId,
          actor: actionActor,
        })
        return { upload: safeUpload(cancelled.upload), replayed: cancelled.replayed }
      } catch (error) {
        mapActionError(error)
      }
    }),

  verify: tenantProcedure
    .input(z.object({ venueId, uploadId, claimId }).strict())
    .mutation(async ({ ctx, input }) => {
      const actionActor = actor(ctx.session)
      const scope = {
        client: ctx.db,
        tenantId: ctx.session.activeTenantId,
        venueId: input.venueId,
        uploadId: input.uploadId,
        actor: actionActor,
        claimId: input.claimId,
      }
      let claimed: Awaited<ReturnType<typeof claimIntakeUploadVerificationAction>>
      try {
        // Claim ownership durably before reading mutable external state.
        claimed = await claimIntakeUploadVerificationAction(scope)
      } catch (error) {
        mapActionError(error)
      }

      if (claimed.state === 'AWAITING_REVIEW') {
        return {
          upload: safeUpload(claimed.upload),
          retryable: false,
          nextAction: 'PATHFINDER_REVIEW' as const,
          autoApprove: false as const,
          autoApply: false as const,
          published: false as const,
        }
      }
      if (claimed.state === 'PRECHECK_PASSED') {
        try {
          const settled = await runAuthoritativeVerification({
            scope,
            target: claimed.uploadTarget,
          })
          if (settled)
            return {
              upload: safeUpload(settled.upload),
              retryable: false,
              nextAction: settled.nextAction,
              processingState:
                settled.nextAction === 'PATHFINDER_REVIEW'
                  ? ('READY_FOR_REVIEW' as const)
                  : ('REJECTED' as const),
              autoApprove: false as const,
              autoApply: false as const,
              published: false as const,
            }
        } catch (cause) {
          try {
            await releaseIntakeUploadAuthoritativeVerificationAction(scope)
          } catch {
            // Preserve the original availability error; claim recovery remains lease-bounded.
          }
          throw publicTRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message: 'Security verification is temporarily unavailable. Retry this file.',
            cause,
          })
        }
        return {
          upload: safeUpload(claimed.upload),
          retryable: true,
          nextAction: 'MALWARE_SCAN_PENDING' as const,
          processingState: 'MALWARE_SCAN_PENDING' as const,
          autoApprove: false as const,
          autoApply: false as const,
          published: false as const,
        }
      }

      const controller = new AbortController()
      let ownershipLost = false
      let renewal: Promise<void> = Promise.resolve()
      const renew = () => {
        renewal = renewal.then(async () => {
          try {
            await renewIntakeUploadVerificationLeaseAction(scope)
          } catch (error) {
            ownershipLost = true
            controller.abort()
            throw error
          }
        })
        return renewal
      }
      const heartbeat = setInterval(() => void renew().catch(() => undefined), 60_000)
      try {
        await renew()
      } catch (error) {
        clearInterval(heartbeat)
        mapActionError(error)
      }

      let inspection: Awaited<ReturnType<typeof inspectIntakeUpload>>
      try {
        inspection = await inspectIntakeUpload({
          key: claimed.uploadTarget.objectKey,
          generation: claimed.uploadTarget.objectGeneration,
          contentType: claimed.uploadTarget.mimeType,
          bytes: claimed.uploadTarget.byteSize,
          checksumSha256: claimed.uploadTarget.sha256,
          signal: controller.signal,
        })
      } catch (cause) {
        clearInterval(heartbeat)
        if (!ownershipLost) {
          try {
            await releaseIntakeUploadVerificationAction({
              ...scope,
              reasonCode: 'TRANSPORT_UNAVAILABLE',
            })
          } catch (error) {
            mapActionError(error)
          }
        }
        throw publicTRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Upload verification is temporarily unavailable. Retry with the same claim.',
          cause,
        })
      }

      if (inspection.state === 'missing') {
        clearInterval(heartbeat)
        try {
          const result = await rejectIntakeUploadAction({
            ...scope,
            reasonCode: 'OBJECT_MISSING',
          })
          return {
            upload: safeUpload(result.upload),
            retryable: false,
            nextAction: 'RESELECT_FILE' as const,
          }
        } catch (error) {
          mapActionError(error)
        }
      }

      if (inspection.state === 'invalid') {
        if (!inspection.versionId || inspection.reason === 'version') {
          clearInterval(heartbeat)
          try {
            await releaseIntakeUploadVerificationAction({
              ...scope,
              reasonCode: 'VERIFICATION_UNAVAILABLE',
            })
          } catch (error) {
            mapActionError(error)
          }
          throw publicTRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message:
              'The immutable upload version could not be confirmed. Retry with the same claim.',
          })
        }
        try {
          // The precise HEAD-confirmed version is the only object this flow may remove.
          await deleteInvalidIntakeUploadVersion({
            key: claimed.uploadTarget.objectKey,
            versionId: inspection.versionId,
            signal: controller.signal,
          })
        } catch (cause) {
          clearInterval(heartbeat)
          try {
            await releaseIntakeUploadVerificationAction({
              ...scope,
              reasonCode: 'VERIFICATION_UNAVAILABLE',
            })
          } catch (error) {
            mapActionError(error)
          }
          throw publicTRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message:
              'The invalid upload could not be quarantined safely. Retry with the same claim.',
            cause,
          })
        }
        try {
          const result = await rejectIntakeUploadAction({
            ...scope,
            reasonCode: rejectionCodeByInspection[inspection.reason],
          })
          clearInterval(heartbeat)
          return {
            upload: safeUpload(result.upload),
            retryable: false,
            nextAction: 'RESELECT_FILE' as const,
          }
        } catch (error) {
          mapActionError(error)
        }
      }

      try {
        let format: Awaited<ReturnType<typeof verifyIntakeUploadBytes>>
        try {
          await renew()
          const bytes = await readIntakeUploadVersion({
            key: claimed.uploadTarget.objectKey,
            versionId: inspection.versionId,
            signal: controller.signal,
          })
          let renewedAtBytes = 0
          format = await verifyIntakeUploadBytes({
            bytes,
            mimeType: IntakeUploadMimeType.parse(claimed.uploadTarget.mimeType),
            expectedBytes: claimed.uploadTarget.byteSize,
            expectedSha256: claimed.uploadTarget.sha256,
            storageVersionId: inspection.versionId,
            objectGeneration: claimed.uploadTarget.objectGeneration,
            signal: controller.signal,
            onProgress: async (byteSize) => {
              if (byteSize - renewedAtBytes < 1024 * 1024) return
              await renew()
              renewedAtBytes = byteSize
            },
          })
          await renewal
        } catch (cause) {
          if (!ownershipLost) {
            await releaseIntakeUploadVerificationAction({
              ...scope,
              reasonCode: 'VERIFICATION_UNAVAILABLE',
            })
          }
          throw publicTRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message: 'File verification is temporarily unavailable. Retry with the same claim.',
            cause,
          })
        } finally {
          clearInterval(heartbeat)
        }
        if (!format.passed) {
          const reasonCode =
            format.reason === 'SIZE_MISMATCH'
              ? ('SIZE_MISMATCH' as const)
              : format.reason === 'HASH_MISMATCH'
                ? ('HASH_MISMATCH' as const)
                : format.reason === 'FORMAT_MISMATCH'
                  ? ('MIME_MISMATCH' as const)
                  : ('UNSAFE_FILE' as const)
          const result = await recordRejectedIntakeUploadPrecheckAction({
            ...scope,
            reasonCode,
            verified: {
              objectGeneration: claimed.uploadTarget.objectGeneration,
              storageVersionId: inspection.versionId,
              mimeType: IntakeUploadMimeType.parse(claimed.uploadTarget.mimeType),
              byteSize: claimed.uploadTarget.byteSize,
              sha256: claimed.uploadTarget.sha256,
            },
            evidence: {
              engine: format.engine,
              engineVersion: format.engineVersion,
              verdictHash: format.verdictHash,
              computedByteSize: format.computedByteSize,
              computedSha256: format.computedSha256,
            },
          })
          return {
            upload: safeUpload(result.upload),
            retryable: false,
            nextAction: 'RESELECT_FILE' as const,
          }
        }
        const result = await recordIntakeUploadPrecheckAction({
          ...scope,
          verified: {
            objectGeneration: claimed.uploadTarget.objectGeneration,
            storageVersionId: inspection.versionId,
            mimeType: IntakeUploadMimeType.parse(claimed.uploadTarget.mimeType),
            byteSize: claimed.uploadTarget.byteSize,
            sha256: claimed.uploadTarget.sha256,
          },
          evidence: {
            engine: format.engine,
            engineVersion: format.engineVersion,
            verdictHash: format.verdictHash,
            computedByteSize: format.computedByteSize,
            computedSha256: format.computedSha256,
          },
        })
        if (configuredIntakeUploadMalwareScanner() === null)
          return {
            upload: safeUpload(result.upload),
            retryable: true,
            nextAction: result.nextAction,
            processingState: 'MALWARE_SCAN_PENDING' as const,
            autoApprove: false as const,
            autoApply: false as const,
            published: false as const,
          }
        const authoritativeClaim = await claimIntakeUploadVerificationAction(scope)
        if (authoritativeClaim.state !== 'PRECHECK_PASSED')
          throw new IntakeUploadActionError(
            'CONFLICT',
            'Upload could not enter authoritative verification',
          )
        let settled: Awaited<ReturnType<typeof runAuthoritativeVerification>>
        try {
          settled = await runAuthoritativeVerification({
            scope,
            target: {
              ...authoritativeClaim.uploadTarget,
              storageVersionId: inspection.versionId,
            },
          })
        } catch (cause) {
          try {
            await releaseIntakeUploadAuthoritativeVerificationAction(scope)
          } catch {
            // Preserve the original availability error; claim recovery remains lease-bounded.
          }
          throw publicTRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message: 'Security verification is temporarily unavailable. Retry this file.',
            cause,
          })
        }
        if (settled)
          return {
            upload: safeUpload(settled.upload),
            retryable: false,
            nextAction: settled.nextAction,
            processingState:
              settled.nextAction === 'PATHFINDER_REVIEW'
                ? ('READY_FOR_REVIEW' as const)
                : ('REJECTED' as const),
            autoApprove: false as const,
            autoApply: false as const,
            published: false as const,
          }
        throw new IntakeUploadActionError('CONFLICT', 'Authoritative verification did not settle')
      } catch (error) {
        mapActionError(error)
      }
    }),

  list: tenantProcedure
    .input(
      z
        .object({
          venueId,
          limit: z.number().int().min(1).max(50).default(25),
          cursor: IntakeUploadCursor.optional(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        const result = await listIntakeUploadsAction({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        })
        return { items: result.items.map(safeUpload), nextCursor: result.nextCursor }
      } catch (error) {
        mapActionError(error)
      }
    }),
})
import { randomUUID } from 'node:crypto'
