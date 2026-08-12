import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  IntakeUploadActionError,
  claimIntakeUploadVerificationAction,
  finalizeVerifiedIntakeUploadAction,
  listIntakeUploadsAction,
  rejectIntakeUploadAction,
  releaseIntakeUploadVerificationAction,
  reserveIntakeUploadAction,
  type IntakeUploadActor,
} from '@pathfinder/db'
import {
  IntakeUploadCursor,
  IntakeUploadMimeType,
  IntakeUploadReserveRequest,
} from '@pathfinder/contracts/intake-upload'

import { publicTRPCError, router } from '../core'
import {
  createIntakeUploadObjectKey,
  deleteInvalidIntakeUploadVersion,
  inspectIntakeUpload,
  signIntakeUploadPut,
} from '../lib/intake-upload-storage'
import { tenantProcedure } from '../trpc'

const venueId = z.string().trim().min(1).max(191)
const uploadId = z.string().trim().min(1).max(191)
const claimId = z.string().uuid()

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
          uploadRequest: signed,
        }
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

      let inspection: Awaited<ReturnType<typeof inspectIntakeUpload>>
      try {
        inspection = await inspectIntakeUpload({
          key: claimed.uploadTarget.objectKey,
          generation: claimed.uploadTarget.objectGeneration,
          contentType: claimed.uploadTarget.mimeType,
          bytes: claimed.uploadTarget.byteSize,
          checksumSha256: claimed.uploadTarget.sha256,
        })
      } catch (cause) {
        try {
          await releaseIntakeUploadVerificationAction({
            ...scope,
            reasonCode: 'TRANSPORT_UNAVAILABLE',
          })
        } catch (error) {
          mapActionError(error)
        }
        throw publicTRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Upload verification is temporarily unavailable. Retry with the same claim.',
          cause,
        })
      }

      if (inspection.state === 'missing') {
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
          })
        } catch (cause) {
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
        const result = await finalizeVerifiedIntakeUploadAction({
          ...scope,
          verified: {
            objectGeneration: claimed.uploadTarget.objectGeneration,
            storageVersionId: inspection.versionId,
            mimeType: IntakeUploadMimeType.parse(claimed.uploadTarget.mimeType),
            byteSize: claimed.uploadTarget.byteSize,
            sha256: claimed.uploadTarget.sha256,
          },
        })
        return {
          upload: safeUpload(result.upload),
          retryable: false,
          nextAction: result.nextAction,
          autoApprove: result.autoApprove,
          autoApply: result.autoApply,
          published: result.published,
        }
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
