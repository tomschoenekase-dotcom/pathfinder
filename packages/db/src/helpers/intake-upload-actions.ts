import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import {
  IntakeUploadCursor,
  IntakeUploadRejectionCode,
  IntakeUploadReserveRequest,
  IntakeUploadRetryReason,
  INTAKE_UPLOAD_NON_MEDIA_MAX_BYTES,
  INTAKE_UPLOAD_VENUE_MAX_BYTES,
  IntakeUploadVerificationEvidence,
  IntakeUploadVerifiedTransport,
  type IntakeUploadReserveRequest as IntakeUploadReserveRequestType,
  type IntakeUploadVerifiedTransport as IntakeUploadVerifiedTransportType,
  type IntakeUploadVerificationEvidence as IntakeUploadVerificationEvidenceType,
} from '@pathfinder/contracts/intake-upload'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { recordOrReplayOnboardingMilestoneEvent } from './onboarding-milestone-events'

export type IntakeUploadActor = {
  type: 'HUMAN'
  id: string
  role: 'STAFF' | 'MANAGER' | 'OWNER' | 'PLATFORM_ADMIN'
}

export type IntakeUploadActionClient = Pick<
  typeof db,
  '$transaction' | 'intakeUpload' | 'intakeUploadVerificationReceipt' | 'venue'
>

export type IntakeUploadActionErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VERIFICATION_MISMATCH'

export class IntakeUploadActionError extends Error {
  constructor(
    readonly code: IntakeUploadActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'IntakeUploadActionError'
  }
}

export const INTAKE_UPLOAD_VERIFICATION_LEASE_MS = 10 * 60 * 1_000

export type TrustedIntakeUploadObjectIdentity = {
  objectKey: string
  objectGeneration: string
}

const trustedObjectIdentityInput = z
  .object({
    objectKey: z
      .string()
      .min(1)
      .max(255)
      .regex(/^(?:(?:staging|preview)\/)?intake-quarantine\/[a-f0-9-]+$/u),
    objectGeneration: z.string().uuid(),
  })
  .strict()

const actorInput = z
  .object({
    type: z.literal('HUMAN'),
    id: z.string().trim().min(1).max(191),
    role: z.enum(['STAFF', 'MANAGER', 'OWNER', 'PLATFORM_ADMIN']),
  })
  .strict()

const scopeInput = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    uploadId: z.string().trim().min(1).max(191),
  })
  .strict()

const claimIdInput = z.string().uuid()
const multipartUploadIdInput = z.string().trim().min(1).max(1024)

const uploadStateSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  requestId: true,
  requestHash: true,
  displayName: true,
  fileName: true,
  mimeType: true,
  category: true,
  byteSize: true,
  sha256: true,
  objectKey: true,
  objectGeneration: true,
  storageVersionId: true,
  multipartUploadId: true,
  multipartStartedAt: true,
  multipartCompletedAt: true,
  multipartAbortedAt: true,
  status: true,
  verificationClaimId: true,
  verificationClaimedAt: true,
  verificationLeaseUntil: true,
  verifiedAt: true,
  rejectedAt: true,
  rejectionCode: true,
  intakeRunId: true,
  requestedBy: true,
  requestedByRole: true,
  createdAt: true,
  updatedAt: true,
} as const

const safeListSelect = {
  id: true,
  status: true,
  displayName: true,
  fileName: true,
  mimeType: true,
  category: true,
  byteSize: true,
  rejectionCode: true,
  intakeRunId: true,
  verificationLeaseUntil: true,
  createdAt: true,
  updatedAt: true,
} as const

const safeDetailSelect = {
  ...safeListSelect,
  verifiedAt: true,
  rejectedAt: true,
} as const

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function intakeUploadRequestHash(request: IntakeUploadReserveRequestType): string {
  const parsed = IntakeUploadReserveRequest.parse(request)
  const identity = {
    displayName: parsed.displayName,
    fileName: parsed.fileName,
    mimeType: parsed.mimeType,
    byteSize: parsed.byteSize,
    sha256: parsed.sha256,
  }
  return createHash('sha256').update(canonicalJson(identity)).digest('hex')
}

function parseActor(actor: unknown): IntakeUploadActor {
  const parsed = actorInput.safeParse(actor)
  if (!parsed.success)
    throw new IntakeUploadActionError('INVALID_INPUT', 'A permitted human actor is required')
  return parsed.data
}

function parseScope(input: unknown) {
  const candidate =
    input && typeof input === 'object'
      ? {
          tenantId: (input as Record<string, unknown>).tenantId,
          venueId: (input as Record<string, unknown>).venueId,
          uploadId: (input as Record<string, unknown>).uploadId,
        }
      : input
  const parsed = scopeInput.safeParse(candidate)
  if (!parsed.success)
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid intake upload scope')
  return parsed.data
}

function intakeUploadWhere(scope: ReturnType<typeof parseScope>) {
  return {
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    id: scope.uploadId,
  }
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
  verificationLeaseUntil?: Date | null
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
    verificationLeaseActive:
      upload.status === 'VERIFYING' &&
      Boolean(upload.verificationLeaseUntil && upload.verificationLeaseUntil > new Date()),
    createdAt: upload.createdAt,
    updatedAt: upload.updatedAt,
  }
}

function uploadTarget(upload: {
  objectKey: string
  objectGeneration: string
  mimeType: string
  byteSize: number
  sha256: string
  storageVersionId?: string | null
  multipartUploadId?: string | null
  multipartStartedAt?: Date | null
  multipartCompletedAt?: Date | null
  multipartAbortedAt?: Date | null
}) {
  return {
    objectKey: upload.objectKey,
    objectGeneration: upload.objectGeneration,
    mimeType: upload.mimeType,
    byteSize: upload.byteSize,
    sha256: upload.sha256,
    storageVersionId: upload.storageVersionId ?? null,
    multipartUploadId: upload.multipartUploadId ?? null,
    multipartStartedAt: upload.multipartStartedAt ?? null,
    multipartCompletedAt: upload.multipartCompletedAt ?? null,
    multipartAbortedAt: upload.multipartAbortedAt ?? null,
  }
}

function requireUploadOwner(
  upload: { requestedBy: string; requestedByRole: string },
  actor: IntakeUploadActor,
) {
  if (upload.requestedBy !== actor.id || upload.requestedByRole !== actor.role) {
    throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
  }
}

export async function reserveIntakeUploadAction(input: {
  tenantId: string
  venueId: string
  actor: IntakeUploadActor
  request: IntakeUploadReserveRequestType
  trustedObjectIdentity: TrustedIntakeUploadObjectIdentity
  client?: IntakeUploadActionClient
}) {
  if (!input || typeof input !== 'object')
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid intake upload reservation')
  const scope = parseScope({
    tenantId: input.tenantId,
    venueId: input.venueId,
    uploadId: 'reserve',
  })
  const actor = parseActor(input.actor)
  const parsed = IntakeUploadReserveRequest.safeParse(input.request)
  if (!parsed.success)
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid intake upload reservation')
  const request = parsed.data
  const media = request.mimeType.startsWith('video/') || request.mimeType.startsWith('audio/')
  if (!media && request.byteSize > INTAKE_UPLOAD_NON_MEDIA_MAX_BYTES) {
    throw new IntakeUploadActionError(
      'INVALID_INPUT',
      'Documents and images must be 100 MB or smaller',
    )
  }
  const requestHash = intakeUploadRequestHash(request)
  const trustedObjectIdentity = trustedObjectIdentityInput.safeParse(input.trustedObjectIdentity)
  if (!trustedObjectIdentity.success)
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid trusted upload object identity')
  const client = input.client ?? db

  try {
    return await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-upload:${scope.tenantId}:${request.requestId}`}, 0))`
      const replay = await tx.intakeUpload.findFirst({
        where: { tenantId: scope.tenantId, requestId: request.requestId },
        select: uploadStateSelect,
      })
      if (replay) {
        if (
          replay.requestHash !== requestHash ||
          replay.category !== request.category ||
          replay.venueId !== scope.venueId ||
          replay.requestedBy !== actor.id ||
          replay.requestedByRole !== actor.role
        ) {
          throw new IntakeUploadActionError(
            'CONFLICT',
            'This request key is already bound to different file metadata.',
          )
        }
        return {
          upload: safeUpload(replay),
          uploadTarget: uploadTarget(replay),
          replayed: true,
          nextAction:
            replay.status === 'RESERVED' ? ('UPLOAD_BYTES' as const) : ('REVIEW_STATUS' as const),
        }
      }
      const venue = await tx.venue.findFirst({
        where: { tenantId: scope.tenantId, id: scope.venueId },
        select: { id: true },
      })
      if (!venue) throw new IntakeUploadActionError('NOT_FOUND', 'Venue not found')

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-upload-quota:${scope.tenantId}:${scope.venueId}`}, 0))`

      const activeBytes = await tx.intakeUpload.aggregate({
        where: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          status: { not: 'REJECTED' },
        },
        _sum: { byteSize: true },
      })
      if ((activeBytes._sum.byteSize ?? 0) + request.byteSize > INTAKE_UPLOAD_VENUE_MAX_BYTES) {
        throw new IntakeUploadActionError(
          'CONFLICT',
          'This venue has reached its 50 GB material allowance.',
        )
      }

      const upload = await tx.intakeUpload.create({
        data: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          requestId: request.requestId,
          requestHash,
          displayName: request.displayName,
          fileName: request.fileName,
          mimeType: request.mimeType,
          category: request.category,
          byteSize: request.byteSize,
          sha256: request.sha256,
          objectKey: trustedObjectIdentity.data.objectKey,
          objectGeneration: trustedObjectIdentity.data.objectGeneration,
          status: 'RESERVED',
          requestedBy: actor.id,
          requestedByRole: actor.role,
        },
        select: uploadStateSelect,
      })
      await writeAuditLogStrict(
        {
          tenantId: scope.tenantId,
          actorId: actor.id,
          actorRole: actor.role,
          action: 'intake-upload.reserved',
          targetType: 'IntakeUpload',
          targetId: upload.id,
          afterState: {
            venueId: scope.venueId,
            status: 'RESERVED',
            mimeType: request.mimeType,
            byteSize: request.byteSize,
          },
        },
        tx,
      )
      return {
        upload: safeUpload(upload),
        uploadTarget: uploadTarget(upload),
        replayed: false,
        nextAction: 'UPLOAD_BYTES' as const,
      }
    })
  } catch (error) {
    if (error instanceof IntakeUploadActionError) throw error
    if (isUniqueConflict(error)) {
      const replay = await client.intakeUpload.findFirst({
        where: { tenantId: scope.tenantId, requestId: request.requestId },
        select: uploadStateSelect,
      })
      if (
        replay?.requestHash === requestHash &&
        replay.category === request.category &&
        replay.venueId === scope.venueId &&
        replay.requestedBy === actor.id &&
        replay.requestedByRole === actor.role
      ) {
        return {
          upload: safeUpload(replay),
          uploadTarget: uploadTarget(replay),
          replayed: true,
          nextAction:
            replay.status === 'RESERVED' ? ('UPLOAD_BYTES' as const) : ('REVIEW_STATUS' as const),
        }
      }
      throw new IntakeUploadActionError(
        'CONFLICT',
        'Upload reservation conflicts with existing data',
      )
    }
    throw error
  }
}

export async function claimIntakeUploadVerificationAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  actor: IntakeUploadActor
  claimId: string
  client?: IntakeUploadActionClient
}) {
  if (!input || typeof input !== 'object')
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid verification claim')
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const claim = claimIdInput.safeParse(input.claimId)
  if (!claim.success)
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid verification claim')
  const client = input.client ?? db
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const uploadWhere = intakeUploadWhere(scope)
    const current = await tx.intakeUpload.findFirst({
      where: uploadWhere,
      select: uploadStateSelect,
    })
    if (!current) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireUploadOwner(current, actor)
    if (current.status === 'AWAITING_REVIEW' && current.intakeRunId) {
      return {
        state: 'AWAITING_REVIEW' as const,
        upload: safeUpload(current),
        replayed: true as const,
      }
    }
    if (current.status === 'PRECHECK_PASSED') {
      const now = new Date()
      const leaseUntil = new Date(now.getTime() + INTAKE_UPLOAD_VERIFICATION_LEASE_MS)
      const changed = await tx.intakeUpload.updateMany({
        where: { ...uploadWhere, status: 'PRECHECK_PASSED', verificationClaimId: null },
        data: {
          status: 'VERIFYING',
          verificationClaimId: claim.data,
          verificationClaimedAt: now,
          verificationLeaseUntil: leaseUntil,
        },
      })
      if (changed.count !== 1)
        throw new IntakeUploadActionError('CONFLICT', 'Intake upload verification was claimed')
      return {
        state: 'PRECHECK_PASSED' as const,
        upload: safeUpload({ ...current, status: 'VERIFYING', updatedAt: now }),
        uploadTarget: uploadTarget(current),
        replayed: false as const,
      }
    }
    const now = new Date()
    if (
      current.status === 'VERIFYING' &&
      current.verificationClaimId === claim.data &&
      current.verificationLeaseUntil &&
      current.verificationLeaseUntil > now
    ) {
      return {
        state: 'VERIFYING' as const,
        upload: safeUpload(current),
        uploadTarget: uploadTarget(current),
        replayed: true as const,
      }
    }
    const expired =
      current.status === 'VERIFYING' &&
      current.verificationLeaseUntil !== null &&
      current.verificationLeaseUntil <= now
    if (current.status !== 'RESERVED' && !expired)
      throw new IntakeUploadActionError(
        'CONFLICT',
        'Intake upload is not available for verification',
      )
    const leaseUntil = new Date(now.getTime() + INTAKE_UPLOAD_VERIFICATION_LEASE_MS)
    const changed = await tx.intakeUpload.updateMany({
      where: {
        ...uploadWhere,
        OR: [
          { status: 'RESERVED', verificationClaimId: null, verificationLeaseUntil: null },
          { status: 'VERIFYING', verificationLeaseUntil: { lte: now } },
        ],
      },
      data: {
        status: 'VERIFYING',
        verificationClaimId: claim.data,
        verificationClaimedAt: now,
        verificationLeaseUntil: leaseUntil,
      },
    })
    if (changed.count !== 1)
      throw new IntakeUploadActionError('CONFLICT', 'Intake upload verification was claimed')
    await writeAuditLogStrict(
      {
        tenantId: scope.tenantId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'intake-upload.verification-claimed',
        targetType: 'IntakeUpload',
        targetId: scope.uploadId,
        beforeState: { status: current.status, expiredClaimRecovered: expired },
        afterState: { venueId: scope.venueId, status: 'VERIFYING', leaseSeconds: 600 },
      },
      tx,
    )
    const claimed = await tx.intakeUpload.findFirst({
      where: uploadWhere,
      select: uploadStateSelect,
    })
    if (!claimed) throw new Error('Claimed intake upload disappeared')
    return {
      state: 'VERIFYING' as const,
      upload: safeUpload(claimed),
      uploadTarget: uploadTarget(claimed),
      replayed: false as const,
    }
  })
}

export async function releaseIntakeUploadVerificationAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  actor: IntakeUploadActor
  claimId: string
  reasonCode: z.infer<typeof IntakeUploadRetryReason>
  client?: IntakeUploadActionClient
}) {
  if (!input || typeof input !== 'object')
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid verification retry record')
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const claim = claimIdInput.safeParse(input.claimId)
  const reason = IntakeUploadRetryReason.safeParse(input.reasonCode)
  if (!claim.success || !reason.success)
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid verification retry record')
  const client = input.client ?? db
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const uploadWhere = intakeUploadWhere(scope)
    const current = await tx.intakeUpload.findFirst({
      where: uploadWhere,
      select: uploadStateSelect,
    })
    if (!current) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireUploadOwner(current, actor)
    if (current.status !== 'VERIFYING' || current.verificationClaimId !== claim.data)
      throw new IntakeUploadActionError('CONFLICT', 'Verification claim no longer owns this upload')
    const now = new Date()
    const leaseUntil = new Date(now.getTime() + INTAKE_UPLOAD_VERIFICATION_LEASE_MS)
    const changed = await tx.intakeUpload.updateMany({
      where: { ...uploadWhere, status: 'VERIFYING', verificationClaimId: claim.data },
      data: { verificationClaimedAt: now, verificationLeaseUntil: leaseUntil },
    })
    if (changed.count !== 1)
      throw new IntakeUploadActionError('CONFLICT', 'Verification claim no longer owns this upload')
    await writeAuditLogStrict(
      {
        tenantId: scope.tenantId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'intake-upload.verification-unavailable',
        targetType: 'IntakeUpload',
        targetId: scope.uploadId,
        beforeState: { status: 'VERIFYING' },
        afterState: {
          venueId: scope.venueId,
          status: 'VERIFYING',
          reasonCode: reason.data,
          retryable: true,
        },
      },
      tx,
    )
    return {
      upload: safeUpload({ ...current, updatedAt: now }),
      uploadTarget: uploadTarget(current),
      retryable: true as const,
    }
  })
}

export async function renewIntakeUploadVerificationLeaseAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  actor: IntakeUploadActor
  claimId: string
  client?: IntakeUploadActionClient
}) {
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const claim = claimIdInput.safeParse(input.claimId)
  if (!claim.success)
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid verification claim')
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + INTAKE_UPLOAD_VERIFICATION_LEASE_MS)
  const client = input.client ?? db
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const uploadWhere = intakeUploadWhere(scope)
    const current = await tx.intakeUpload.findFirst({
      where: uploadWhere,
      select: uploadStateSelect,
    })
    if (!current) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireUploadOwner(current, actor)
    const changed = await tx.intakeUpload.updateMany({
      where: {
        ...uploadWhere,
        status: 'VERIFYING',
        verificationClaimId: claim.data,
        verificationLeaseUntil: { gt: now },
      },
      data: { verificationLeaseUntil: leaseUntil },
    })
    if (changed.count !== 1)
      throw new IntakeUploadActionError('CONFLICT', 'Verification claim no longer owns this upload')
    return { leaseUntil }
  })
}

export async function rejectIntakeUploadAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  actor: IntakeUploadActor
  claimId: string
  reasonCode: z.infer<typeof IntakeUploadRejectionCode>
  client?: IntakeUploadActionClient
}) {
  return settleRejectedClaim(input)
}

async function settleRejectedClaim(input: {
  tenantId: string
  venueId: string
  uploadId: string
  actor: IntakeUploadActor
  claimId: string
  reasonCode: string
  client?: IntakeUploadActionClient
}) {
  if (!input || typeof input !== 'object')
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid verification settlement')
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const claim = claimIdInput.safeParse(input.claimId)
  const reason = IntakeUploadRejectionCode.safeParse(input.reasonCode)
  if (!claim.success || !reason.success)
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid verification settlement')
  const client = input.client ?? db
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const uploadWhere = intakeUploadWhere(scope)
    const current = await tx.intakeUpload.findFirst({
      where: uploadWhere,
      select: uploadStateSelect,
    })
    if (!current) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireUploadOwner(current, actor)
    if (current.status !== 'VERIFYING' || current.verificationClaimId !== claim.data)
      throw new IntakeUploadActionError('CONFLICT', 'Verification claim no longer owns this upload')
    const now = new Date()
    if (!current.verificationLeaseUntil || current.verificationLeaseUntil <= now)
      throw new IntakeUploadActionError('CONFLICT', 'Verification claim lease expired')
    const changed = await tx.intakeUpload.updateMany({
      where: {
        ...uploadWhere,
        status: 'VERIFYING',
        verificationClaimId: claim.data,
        verificationLeaseUntil: { gt: now },
      },
      data: {
        status: 'REJECTED',
        verificationClaimId: null,
        verificationClaimedAt: null,
        verificationLeaseUntil: null,
        rejectedAt: now,
        rejectionCode: reason.data,
      },
    })
    if (changed.count !== 1)
      throw new IntakeUploadActionError('CONFLICT', 'Verification claim no longer owns this upload')
    await writeAuditLogStrict(
      {
        tenantId: scope.tenantId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'intake-upload.rejected',
        targetType: 'IntakeUpload',
        targetId: scope.uploadId,
        beforeState: { status: 'VERIFYING' },
        afterState: {
          venueId: scope.venueId,
          status: 'REJECTED',
          reasonCode: reason.data,
          retryable: false,
        },
      },
      tx,
    )
    const settled = await tx.intakeUpload.findFirst({
      where: uploadWhere,
      select: safeDetailSelect,
    })
    if (!settled) throw new Error('Settled intake upload disappeared')
    return { upload: safeUpload(settled), retryable: false as const }
  })
}

export async function recordIntakeUploadPrecheckAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  actor: IntakeUploadActor
  claimId: string
  verified: IntakeUploadVerifiedTransportType
  evidence: IntakeUploadVerificationEvidenceType
  client?: IntakeUploadActionClient
}) {
  if (!input || typeof input !== 'object')
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid verified upload settlement')
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const claim = claimIdInput.safeParse(input.claimId)
  const verified = IntakeUploadVerifiedTransport.safeParse(input.verified)
  const evidence = IntakeUploadVerificationEvidence.safeParse(input.evidence)
  if (!claim.success || !verified.success || !evidence.success)
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid verified upload settlement')
  const client = input.client ?? db
  try {
    return await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const uploadWhere = intakeUploadWhere(scope)
      const upload = await tx.intakeUpload.findFirst({
        where: uploadWhere,
        select: uploadStateSelect,
      })
      if (!upload) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
      requireUploadOwner(upload, actor)
      const transportMismatch =
        upload.objectGeneration !== verified.data.objectGeneration ||
        upload.mimeType !== verified.data.mimeType ||
        upload.byteSize !== verified.data.byteSize ||
        upload.sha256 !== verified.data.sha256
      if (transportMismatch) {
        throw new IntakeUploadActionError(
          'VERIFICATION_MISMATCH',
          'Verified transport metadata does not match the reservation',
        )
      }
      if (upload.status === 'PRECHECK_PASSED') {
        const receipt = await tx.intakeUploadVerificationReceipt.findFirst({
          where: { ...scope, kind: 'PRECHECK', verdict: 'PASSED' },
          select: { claimId: true, verdictHash: true, storageVersionId: true },
        })
        if (
          receipt?.claimId !== claim.data ||
          receipt.verdictHash !== evidence.data.verdictHash ||
          receipt.storageVersionId !== verified.data.storageVersionId
        )
          throw new IntakeUploadActionError('CONFLICT', 'Stored precheck evidence is inconsistent')
        return {
          upload: safeUpload(upload),
          replayed: true as const,
          nextAction: 'MALWARE_SCAN_PENDING' as const,
        }
      }
      if (upload.status !== 'VERIFYING' || upload.verificationClaimId !== claim.data)
        throw new IntakeUploadActionError(
          'CONFLICT',
          'Verification claim no longer owns this upload',
        )
      const now = new Date()
      if (!upload.verificationLeaseUntil || upload.verificationLeaseUntil <= now)
        throw new IntakeUploadActionError('CONFLICT', 'Verification claim lease expired')
      await tx.intakeUpload.updateMany({
        where: {
          ...uploadWhere,
          status: 'VERIFYING',
          verificationClaimId: claim.data,
          verificationLeaseUntil: { gt: now },
          intakeRunId: null,
        },
        data: {
          storageVersionId: verified.data.storageVersionId,
        },
      })
      await tx.intakeUploadVerificationReceipt.create({
        data: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          uploadId: upload.id,
          kind: 'PRECHECK',
          verdict: 'PASSED',
          engine: evidence.data.engine,
          engineVersion: evidence.data.engineVersion,
          verdictHash: evidence.data.verdictHash,
          objectGeneration: upload.objectGeneration,
          storageVersionId: verified.data.storageVersionId,
          computedByteSize: evidence.data.computedByteSize,
          computedSha256: evidence.data.computedSha256,
          claimId: claim.data,
        },
      })
      const changed = await tx.intakeUpload.updateMany({
        where: {
          ...uploadWhere,
          status: 'VERIFYING',
          verificationClaimId: claim.data,
          verificationLeaseUntil: { gt: now },
          intakeRunId: null,
        },
        data: {
          status: 'PRECHECK_PASSED',
          verificationClaimId: null,
          verificationClaimedAt: null,
          verificationLeaseUntil: null,
          storageVersionId: verified.data.storageVersionId,
        },
      })
      if (changed.count !== 1)
        throw new IntakeUploadActionError(
          'CONFLICT',
          'Verification claim no longer owns this upload',
        )
      await writeAuditLogStrict(
        {
          tenantId: scope.tenantId,
          actorId: actor.id,
          actorRole: actor.role,
          action: 'intake-upload.precheck-passed',
          targetType: 'IntakeUpload',
          targetId: upload.id,
          beforeState: { status: 'VERIFYING' },
          afterState: {
            venueId: scope.venueId,
            status: 'PRECHECK_PASSED',
            mimeType: upload.mimeType,
            byteSize: upload.byteSize,
            malwareScanned: false,
          },
        },
        tx,
      )
      return {
        upload: {
          ...safeUpload(upload),
          status: 'PRECHECK_PASSED',
          updatedAt: now,
        },
        replayed: false as const,
        nextAction: 'MALWARE_SCAN_PENDING' as const,
      }
    })
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    const upload = await client.intakeUpload.findFirst({
      where: intakeUploadWhere(scope),
      select: uploadStateSelect,
    })
    if (!upload) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireUploadOwner(upload, actor)
    const receipt = await client.intakeUploadVerificationReceipt.findFirst({
      where: { ...scope, kind: 'PRECHECK', verdict: 'PASSED' },
      select: {
        claimId: true,
        verdictHash: true,
        storageVersionId: true,
        computedByteSize: true,
        computedSha256: true,
      },
    })
    if (
      upload.status !== 'PRECHECK_PASSED' ||
      receipt?.claimId !== claim.data ||
      receipt.verdictHash !== evidence.data.verdictHash ||
      receipt.storageVersionId !== verified.data.storageVersionId ||
      receipt.computedByteSize !== evidence.data.computedByteSize ||
      receipt.computedSha256 !== evidence.data.computedSha256
    )
      throw new IntakeUploadActionError('CONFLICT', 'Stored precheck evidence is inconsistent')
    return {
      upload: safeUpload(upload),
      replayed: true as const,
      nextAction: 'MALWARE_SCAN_PENDING' as const,
    }
  }
}

export async function settleIntakeUploadAuthoritativeVerificationAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  actor: IntakeUploadActor
  claimId: string
  malware: {
    verdict: 'CLEAN' | 'INFECTED'
    engine: string
    engineVersion: string
    verdictHash: string
    computedByteSize: number
    computedSha256: string
  }
  client?: IntakeUploadActionClient
}) {
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const claim = claimIdInput.parse(input.claimId)
  const malware = z
    .object({
      verdict: z.enum(['CLEAN', 'INFECTED']),
      engine: z.string().trim().min(1).max(64),
      engineVersion: z.string().trim().min(1).max(64),
      verdictHash: z.string().regex(/^[a-f0-9]{64}$/u),
      computedByteSize: z.number().int().min(1),
      computedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .parse(input.malware)
  const client = input.client ?? db
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-authoritative:${scope.tenantId}:${scope.uploadId}`}, 0))`
    const upload = await tx.intakeUpload.findFirst({
      where: intakeUploadWhere(scope),
      select: uploadStateSelect,
    })
    if (!upload) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireUploadOwner(upload, actor)
    if (upload.status === 'AWAITING_REVIEW' && upload.intakeRunId)
      return {
        upload: safeUpload(upload),
        replayed: true as const,
        nextAction: 'PATHFINDER_REVIEW' as const,
      }
    if (upload.status === 'REJECTED')
      return {
        upload: safeUpload(upload),
        replayed: true as const,
        nextAction: 'RESELECT_FILE' as const,
      }
    if (
      upload.status !== 'VERIFYING' ||
      upload.verificationClaimId !== claim ||
      !upload.verificationLeaseUntil ||
      upload.verificationLeaseUntil <= new Date() ||
      !upload.storageVersionId
    )
      throw new IntakeUploadActionError(
        'CONFLICT',
        'Upload is not ready for authoritative verification',
      )

    const precheck = await tx.intakeUploadVerificationReceipt.findFirst({
      where: { ...scope, kind: 'PRECHECK', verdict: 'PASSED' },
      select: {
        claimId: true,
        objectGeneration: true,
        storageVersionId: true,
        computedByteSize: true,
        computedSha256: true,
        verdictHash: true,
      },
    })
    if (
      !precheck ||
      precheck.objectGeneration !== upload.objectGeneration ||
      precheck.storageVersionId !== upload.storageVersionId ||
      precheck.computedByteSize !== upload.byteSize ||
      precheck.computedSha256 !== upload.sha256 ||
      malware.computedByteSize !== upload.byteSize ||
      malware.computedSha256 !== upload.sha256
    )
      throw new IntakeUploadActionError(
        'VERIFICATION_MISMATCH',
        'Authoritative verification does not match immutable upload evidence',
      )

    const resourceVerdictHash = createHash('sha256')
      .update(
        canonicalJson({
          domain: 'pathfinder.intake-resource-safety.v1',
          uploadId: upload.id,
          objectGeneration: upload.objectGeneration,
          storageVersionId: upload.storageVersionId,
          byteSize: upload.byteSize,
          sha256: upload.sha256,
          precheckVerdictHash: precheck.verdictHash,
          policy: 'bounded-structure-and-container-v1',
        }),
      )
      .digest('hex')
    const commonReceipt = {
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      uploadId: upload.id,
      objectGeneration: upload.objectGeneration,
      storageVersionId: upload.storageVersionId,
      computedByteSize: upload.byteSize,
      computedSha256: upload.sha256,
      claimId: claim,
    }
    await tx.intakeUploadVerificationReceipt.create({
      data: {
        ...commonReceipt,
        kind: 'RESOURCE_SAFETY',
        verdict: 'PASSED',
        engine: 'pathfinder-resource-policy',
        engineVersion: '1',
        verdictHash: resourceVerdictHash,
      },
    })
    await tx.intakeUploadVerificationReceipt.create({
      data: {
        ...commonReceipt,
        kind: 'MALWARE',
        verdict: malware.verdict === 'CLEAN' ? 'CLEAN' : 'REJECTED',
        engine: malware.engine,
        engineVersion: malware.engineVersion,
        verdictHash: malware.verdictHash,
      },
    })

    const now = new Date()
    if (malware.verdict === 'INFECTED') {
      await tx.intakeUpload.update({
        where: { id: upload.id },
        data: {
          status: 'REJECTED',
          verificationClaimId: null,
          verificationClaimedAt: null,
          verificationLeaseUntil: null,
          rejectedAt: now,
          rejectionCode: 'UNSAFE_FILE',
        },
      })
      await recordOrReplayOnboardingMilestoneEvent({
        db: tx,
        input: {
          id: randomUUID(),
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          eventType: 'UPLOAD_FAILED',
          idempotencyKey: `intake-upload:${upload.id}:authoritative:${malware.verdictHash}`,
          occurredAt: now,
          actorType: actor.role === 'PLATFORM_ADMIN' ? 'OPERATOR' : 'CLIENT',
          actorId: actor.id,
          sourceType: 'INTAKE_UPLOAD',
          sourceId: upload.id,
          sourceRevision: malware.verdictHash,
          category: upload.category,
          durationMs: Math.max(0, now.getTime() - upload.createdAt.getTime()),
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: scope.tenantId,
          actorId: actor.id,
          actorRole: actor.role,
          action: 'intake-upload.authoritative-rejected',
          targetType: 'IntakeUpload',
          targetId: upload.id,
          beforeState: { status: 'VERIFYING' },
          afterState: { venueId: scope.venueId, status: 'REJECTED', reasonCode: 'UNSAFE_FILE' },
        },
        tx,
      )
      return {
        upload: safeUpload({
          ...upload,
          status: 'REJECTED',
          rejectionCode: 'UNSAFE_FILE',
          updatedAt: now,
        }),
        replayed: false as const,
        nextAction: 'RESELECT_FILE' as const,
      }
    }

    const run = await tx.intakeRun.create({
      data: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        sourceKind: 'FILE_UPLOAD',
        status: 'AWAITING_REVIEW',
        displayName: upload.displayName,
        requestedBy: upload.requestedBy,
      },
      select: { id: true },
    })
    await tx.intakeEvidenceRecord.create({
      data: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        runId: run.id,
        sourceKind: 'FILE_UPLOAD',
        locator: `intake-upload:${upload.id}`,
        normalizedHash: upload.sha256,
        confidence: 1,
        capturedAt: now,
      },
    })
    await tx.intakeRunEvent.createMany({
      data: [
        {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          runId: run.id,
          kind: 'PROPOSAL_CREATED',
          actorId: actor.id,
          metadata: { sourceKind: 'FILE_UPLOAD' },
        },
        {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          runId: run.id,
          kind: 'EVIDENCE_RECORDED',
          actorId: actor.id,
          metadata: { evidenceCount: 1 },
        },
      ],
    })
    const changed = await tx.intakeUpload.updateMany({
      where: {
        ...intakeUploadWhere(scope),
        status: 'VERIFYING',
        verificationClaimId: claim,
        verificationLeaseUntil: { gt: now },
        intakeRunId: null,
      },
      data: {
        status: 'AWAITING_REVIEW',
        verificationClaimId: null,
        verificationClaimedAt: null,
        verificationLeaseUntil: null,
        intakeRunId: run.id,
        verifiedAt: now,
      },
    })
    if (changed.count !== 1)
      throw new IntakeUploadActionError('CONFLICT', 'Upload authoritative settlement raced')
    await recordOrReplayOnboardingMilestoneEvent({
      db: tx,
      input: {
        id: randomUUID(),
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        eventType: 'FIRST_USEFUL_MATERIAL',
        idempotencyKey: `intake-upload:${upload.id}:authoritative:${malware.verdictHash}`,
        occurredAt: now,
        actorType: actor.role === 'PLATFORM_ADMIN' ? 'OPERATOR' : 'CLIENT',
        actorId: actor.id,
        sourceType: 'INTAKE_UPLOAD',
        sourceId: upload.id,
        sourceRevision: malware.verdictHash,
        category: upload.category,
        durationMs: Math.max(0, now.getTime() - upload.createdAt.getTime()),
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: scope.tenantId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'intake-upload.authoritative-verified',
        targetType: 'IntakeUpload',
        targetId: upload.id,
        beforeState: { status: 'VERIFYING' },
        afterState: {
          venueId: scope.venueId,
          status: 'AWAITING_REVIEW',
          intakeRunId: run.id,
          malwareEngine: malware.engine,
        },
      },
      tx,
    )
    return {
      upload: safeUpload({
        ...upload,
        status: 'AWAITING_REVIEW',
        intakeRunId: run.id,
        updatedAt: now,
      }),
      replayed: false as const,
      nextAction: 'PATHFINDER_REVIEW' as const,
    }
  })
}

export async function releaseIntakeUploadAuthoritativeVerificationAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  actor: IntakeUploadActor
  claimId: string
  client?: IntakeUploadActionClient
}) {
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const claim = claimIdInput.parse(input.claimId)
  const client = input.client ?? db
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const current = await tx.intakeUpload.findFirst({
      where: intakeUploadWhere(scope),
      select: uploadStateSelect,
    })
    if (!current) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireUploadOwner(current, actor)
    const precheck = await tx.intakeUploadVerificationReceipt.findFirst({
      where: { ...scope, kind: 'PRECHECK', verdict: 'PASSED' },
      select: { id: true },
    })
    if (
      current.status !== 'VERIFYING' ||
      current.verificationClaimId !== claim ||
      !precheck ||
      !current.storageVersionId
    )
      throw new IntakeUploadActionError('CONFLICT', 'Authoritative verification claim was lost')
    const changed = await tx.intakeUpload.updateMany({
      where: { ...intakeUploadWhere(scope), status: 'VERIFYING', verificationClaimId: claim },
      data: {
        status: 'PRECHECK_PASSED',
        verificationClaimId: null,
        verificationClaimedAt: null,
        verificationLeaseUntil: null,
      },
    })
    if (changed.count !== 1)
      throw new IntakeUploadActionError('CONFLICT', 'Authoritative verification claim was lost')
    await writeAuditLogStrict(
      {
        tenantId: scope.tenantId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'intake-upload.authoritative-unavailable',
        targetType: 'IntakeUpload',
        targetId: current.id,
        beforeState: { status: 'VERIFYING' },
        afterState: { venueId: scope.venueId, status: 'PRECHECK_PASSED', retryable: true },
      },
      tx,
    )
    return {
      upload: safeUpload({ ...current, status: 'PRECHECK_PASSED', updatedAt: new Date() }),
      retryable: true as const,
    }
  })
}

export async function recordRejectedIntakeUploadPrecheckAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  actor: IntakeUploadActor
  claimId: string
  verified: IntakeUploadVerifiedTransportType
  evidence: IntakeUploadVerificationEvidenceType
  reasonCode: 'SIZE_MISMATCH' | 'HASH_MISMATCH' | 'MIME_MISMATCH' | 'UNSAFE_FILE'
  client?: IntakeUploadActionClient
}) {
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const claim = claimIdInput.parse(input.claimId)
  const verified = IntakeUploadVerifiedTransport.parse(input.verified)
  const evidence = IntakeUploadVerificationEvidence.parse(input.evidence)
  const client = input.client ?? db
  try {
    return await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const uploadWhere = intakeUploadWhere(scope)
      const upload = await tx.intakeUpload.findFirst({
        where: uploadWhere,
        select: uploadStateSelect,
      })
      if (!upload) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
      requireUploadOwner(upload, actor)
      const now = new Date()
      if (
        upload.status !== 'VERIFYING' ||
        upload.verificationClaimId !== claim ||
        !upload.verificationLeaseUntil ||
        upload.verificationLeaseUntil <= now ||
        upload.objectGeneration !== verified.objectGeneration ||
        upload.mimeType !== verified.mimeType
      )
        throw new IntakeUploadActionError(
          'CONFLICT',
          'Verification claim no longer owns this upload',
        )
      await tx.intakeUpload.updateMany({
        where: { ...uploadWhere, status: 'VERIFYING', verificationClaimId: claim },
        data: { storageVersionId: verified.storageVersionId },
      })
      await tx.intakeUploadVerificationReceipt.create({
        data: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          uploadId: upload.id,
          kind: 'PRECHECK',
          verdict: 'REJECTED',
          engine: evidence.engine,
          engineVersion: evidence.engineVersion,
          verdictHash: evidence.verdictHash,
          objectGeneration: upload.objectGeneration,
          storageVersionId: verified.storageVersionId,
          computedByteSize: evidence.computedByteSize,
          computedSha256: evidence.computedSha256,
          claimId: claim,
        },
      })
      const changed = await tx.intakeUpload.updateMany({
        where: {
          ...uploadWhere,
          status: 'VERIFYING',
          verificationClaimId: claim,
          verificationLeaseUntil: { gt: now },
        },
        data: {
          status: 'REJECTED',
          verificationClaimId: null,
          verificationClaimedAt: null,
          verificationLeaseUntil: null,
          rejectedAt: now,
          rejectionCode: input.reasonCode,
        },
      })
      if (changed.count !== 1)
        throw new IntakeUploadActionError(
          'CONFLICT',
          'Verification claim no longer owns this upload',
        )
      return {
        upload: safeUpload({
          ...upload,
          status: 'REJECTED',
          rejectionCode: input.reasonCode,
          updatedAt: now,
        }),
        retryable: false as const,
      }
    })
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    const upload = await client.intakeUpload.findFirst({
      where: intakeUploadWhere(scope),
      select: uploadStateSelect,
    })
    if (!upload) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireUploadOwner(upload, actor)
    const receipt = await client.intakeUploadVerificationReceipt.findFirst({
      where: { ...scope, kind: 'PRECHECK', verdict: 'REJECTED' },
      select: {
        claimId: true,
        verdictHash: true,
        storageVersionId: true,
        computedByteSize: true,
        computedSha256: true,
      },
    })
    if (
      upload.status !== 'REJECTED' ||
      upload.rejectionCode !== input.reasonCode ||
      receipt?.claimId !== claim ||
      receipt.verdictHash !== evidence.verdictHash ||
      receipt.storageVersionId !== verified.storageVersionId ||
      receipt.computedByteSize !== evidence.computedByteSize ||
      receipt.computedSha256 !== evidence.computedSha256
    )
      throw new IntakeUploadActionError(
        'CONFLICT',
        'Stored rejected precheck evidence is inconsistent',
      )
    return { upload: safeUpload(upload), retryable: false as const }
  }
}

export async function listIntakeUploadsAction(input: {
  tenantId: string
  venueId: string
  limit: number
  cursor?: z.infer<typeof IntakeUploadCursor>
  client?: IntakeUploadActionClient
}) {
  const parsed = z
    .object({
      tenantId: z.string().trim().min(1).max(191),
      venueId: z.string().trim().min(1).max(191),
      limit: z.number().int().min(1).max(50),
      cursor: IntakeUploadCursor.optional(),
    })
    .strict()
    .safeParse(
      input && typeof input === 'object'
        ? {
            tenantId: input.tenantId,
            venueId: input.venueId,
            limit: input.limit,
            ...(input.cursor ? { cursor: input.cursor } : {}),
          }
        : input,
    )
  if (!parsed.success)
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid upload list scope')
  const client = input.client ?? db
  const venue = await client.venue.findFirst({
    where: { tenantId: parsed.data.tenantId, id: parsed.data.venueId },
    select: { id: true },
  })
  if (!venue) throw new IntakeUploadActionError('NOT_FOUND', 'Venue not found')
  const cursorDate = parsed.data.cursor ? new Date(parsed.data.cursor.createdAt) : null
  const rows = await client.intakeUpload.findMany({
    where: {
      tenantId: parsed.data.tenantId,
      venueId: parsed.data.venueId,
      ...(cursorDate && parsed.data.cursor
        ? {
            OR: [
              { createdAt: { lt: cursorDate } },
              { createdAt: cursorDate, id: { lt: parsed.data.cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: parsed.data.limit + 1,
    select: safeListSelect,
  })
  const hasMore = rows.length > parsed.data.limit
  const items = rows.slice(0, parsed.data.limit).map(safeUpload)
  const last = hasMore ? items.at(-1) : undefined
  return {
    items,
    nextCursor: last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
  }
}

export async function getIntakeUploadDetailAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  client?: IntakeUploadActionClient
}) {
  const scope = parseScope(input)
  const upload = await (input.client ?? db).intakeUpload.findFirst({
    where: intakeUploadWhere(scope),
    select: safeDetailSelect,
  })
  if (!upload) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
  return upload
}

function requireMultipartOwner(upload: { requestedBy: string }, actor: IntakeUploadActor): void {
  if (actor.role !== 'PLATFORM_ADMIN' && upload.requestedBy !== actor.id)
    throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
}

export async function bindIntakeUploadMultipartAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  multipartUploadId: string
  actor: IntakeUploadActor
  client?: IntakeUploadActionClient
}) {
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const multipartUploadId = multipartUploadIdInput.parse(input.multipartUploadId)
  const client = input.client ?? db
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`intake-upload:multipart:${scope.tenantId}:${scope.uploadId}`}, 0))`
    const current = await tx.intakeUpload.findFirst({
      where: intakeUploadWhere(scope),
      select: uploadStateSelect,
    })
    if (!current) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireMultipartOwner(current, actor)
    if (current.status !== 'RESERVED' || current.multipartCompletedAt || current.multipartAbortedAt)
      throw new IntakeUploadActionError('CONFLICT', 'Upload transport is no longer resumable')
    if (current.multipartUploadId) {
      if (current.multipartUploadId !== multipartUploadId)
        throw new IntakeUploadActionError(
          'CONFLICT',
          'Another multipart transport already owns this upload',
        )
      return { upload: current, replayed: true as const }
    }
    const now = new Date()
    const changed = await tx.intakeUpload.updateMany({
      where: {
        ...intakeUploadWhere(scope),
        status: 'RESERVED',
        requestedBy: current.requestedBy,
        multipartUploadId: null,
        multipartStartedAt: null,
      },
      data: { multipartUploadId, multipartStartedAt: now },
    })
    if (changed.count !== 1)
      throw new IntakeUploadActionError(
        'CONFLICT',
        'Upload transport changed; retry the reservation',
      )
    const saved = await tx.intakeUpload.findFirst({
      where: intakeUploadWhere(scope),
      select: uploadStateSelect,
    })
    if (!saved || saved.multipartUploadId !== multipartUploadId)
      throw new IntakeUploadActionError('CONFLICT', 'Multipart transport was not retained')
    await writeAuditLogStrict(
      {
        tenantId: scope.tenantId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'intake-upload.multipart-started',
        targetType: 'IntakeUpload',
        targetId: scope.uploadId,
        afterState: { venueId: scope.venueId, byteSize: saved.byteSize },
      },
      tx,
    )
    return { upload: saved, replayed: false as const }
  })
}

export async function getIntakeUploadMultipartAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  actor: IntakeUploadActor
  allowCompleted?: boolean
  allowCancelled?: boolean
  client?: IntakeUploadActionClient
}) {
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const upload = await (input.client ?? db).intakeUpload.findFirst({
    where: intakeUploadWhere(scope),
    select: uploadStateSelect,
  })
  if (!upload) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
  requireMultipartOwner(upload, actor)
  const isActive =
    upload.status === 'RESERVED' &&
    Boolean(upload.multipartUploadId) &&
    !upload.multipartAbortedAt &&
    (input.allowCompleted || !upload.multipartCompletedAt)
  const isCancelledReplay =
    input.allowCancelled === true &&
    upload.status === 'REJECTED' &&
    upload.rejectionCode === 'CLIENT_CANCELLED' &&
    Boolean(upload.multipartUploadId) &&
    Boolean(upload.multipartAbortedAt) &&
    !upload.multipartCompletedAt
  if (!isActive && !isCancelledReplay)
    throw new IntakeUploadActionError('CONFLICT', 'Multipart upload is not active')
  return {
    upload: safeUpload(upload),
    target: {
      objectKey: upload.objectKey,
      objectGeneration: upload.objectGeneration,
      multipartUploadId: upload.multipartUploadId!,
      byteSize: upload.byteSize,
      mimeType: upload.mimeType,
      sha256: upload.sha256,
      multipartCompletedAt: upload.multipartCompletedAt,
      multipartAbortedAt: upload.multipartAbortedAt,
    },
  }
}

export async function completeIntakeUploadMultipartAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  multipartUploadId: string
  actor: IntakeUploadActor
  client?: IntakeUploadActionClient
}) {
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const multipartUploadId = multipartUploadIdInput.parse(input.multipartUploadId)
  const client = input.client ?? db
  return client.$transaction(async (tx) => {
    const current = await tx.intakeUpload.findFirst({
      where: intakeUploadWhere(scope),
      select: uploadStateSelect,
    })
    if (!current) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireMultipartOwner(current, actor)
    if (current.multipartUploadId !== multipartUploadId || current.multipartAbortedAt)
      throw new IntakeUploadActionError('CONFLICT', 'Multipart upload identity changed')
    if (current.multipartCompletedAt) return { upload: current, replayed: true as const }
    const now = new Date()
    const changed = await tx.intakeUpload.updateMany({
      where: {
        ...intakeUploadWhere(scope),
        status: 'RESERVED',
        multipartUploadId,
        multipartCompletedAt: null,
        multipartAbortedAt: null,
      },
      data: { multipartCompletedAt: now },
    })
    if (changed.count !== 1)
      throw new IntakeUploadActionError('CONFLICT', 'Multipart completion changed')
    const saved = await tx.intakeUpload.findFirst({
      where: intakeUploadWhere(scope),
      select: uploadStateSelect,
    })
    if (!saved)
      throw new IntakeUploadActionError('CONFLICT', 'Multipart completion was not retained')
    await writeAuditLogStrict(
      {
        tenantId: scope.tenantId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'intake-upload.multipart-completed',
        targetType: 'IntakeUpload',
        targetId: scope.uploadId,
        afterState: { venueId: scope.venueId, byteSize: saved.byteSize },
      },
      tx,
    )
    return { upload: saved, replayed: false as const }
  })
}

export async function cancelIntakeUploadMultipartAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  multipartUploadId: string
  actor: IntakeUploadActor
  client?: IntakeUploadActionClient
}) {
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const multipartUploadId = multipartUploadIdInput.parse(input.multipartUploadId)
  const client = input.client ?? db
  return client.$transaction(async (tx) => {
    const current = await tx.intakeUpload.findFirst({
      where: intakeUploadWhere(scope),
      select: uploadStateSelect,
    })
    if (!current) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireMultipartOwner(current, actor)
    if (
      current.status === 'REJECTED' &&
      current.rejectionCode === 'CLIENT_CANCELLED' &&
      current.multipartUploadId === multipartUploadId
    )
      return { upload: current, replayed: true as const }
    if (
      current.status !== 'RESERVED' ||
      current.multipartUploadId !== multipartUploadId ||
      current.multipartCompletedAt
    )
      throw new IntakeUploadActionError('CONFLICT', 'Multipart upload can no longer be cancelled')
    const now = new Date()
    const changed = await tx.intakeUpload.updateMany({
      where: {
        ...intakeUploadWhere(scope),
        status: 'RESERVED',
        multipartUploadId,
        multipartCompletedAt: null,
      },
      data: {
        status: 'REJECTED',
        rejectedAt: now,
        rejectionCode: 'CLIENT_CANCELLED',
        multipartAbortedAt: now,
      },
    })
    if (changed.count !== 1)
      throw new IntakeUploadActionError('CONFLICT', 'Multipart cancellation changed')
    const saved = await tx.intakeUpload.findFirst({
      where: intakeUploadWhere(scope),
      select: uploadStateSelect,
    })
    if (!saved)
      throw new IntakeUploadActionError('CONFLICT', 'Multipart cancellation was not retained')
    await writeAuditLogStrict(
      {
        tenantId: scope.tenantId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'intake-upload.multipart-cancelled',
        targetType: 'IntakeUpload',
        targetId: scope.uploadId,
        afterState: { venueId: scope.venueId, rejectionCode: 'CLIENT_CANCELLED' },
      },
      tx,
    )
    return { upload: saved, replayed: false as const }
  })
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}
