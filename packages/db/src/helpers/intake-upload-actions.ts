import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  IntakeUploadCursor,
  IntakeUploadRejectionCode,
  IntakeUploadReserveRequest,
  IntakeUploadRetryReason,
  IntakeUploadVerifiedTransport,
  type IntakeUploadReserveRequest as IntakeUploadReserveRequestType,
  type IntakeUploadVerifiedTransport as IntakeUploadVerifiedTransportType,
} from '@pathfinder/contracts/intake-upload'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type IntakeUploadActor = {
  type: 'HUMAN'
  id: string
  role: 'STAFF' | 'MANAGER' | 'OWNER' | 'PLATFORM_ADMIN'
}

export type IntakeUploadActionClient = Pick<typeof db, '$transaction' | 'intakeUpload' | 'venue'>

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

const uploadStateSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  requestId: true,
  requestHash: true,
  displayName: true,
  fileName: true,
  mimeType: true,
  byteSize: true,
  sha256: true,
  objectKey: true,
  objectGeneration: true,
  storageVersionId: true,
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
  byteSize: true,
  rejectionCode: true,
  intakeRunId: true,
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

function uploadTarget(upload: {
  objectKey: string
  objectGeneration: string
  mimeType: string
  byteSize: number
  sha256: string
}) {
  return {
    objectKey: upload.objectKey,
    objectGeneration: upload.objectGeneration,
    mimeType: upload.mimeType,
    byteSize: upload.byteSize,
    sha256: upload.sha256,
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

      const upload = await tx.intakeUpload.create({
        data: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          requestId: request.requestId,
          requestHash,
          displayName: request.displayName,
          fileName: request.fileName,
          mimeType: request.mimeType,
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
    const current = await tx.intakeUpload.findFirst({ where: scope, select: uploadStateSelect })
    if (!current) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireUploadOwner(current, actor)
    if (current.status === 'AWAITING_REVIEW' && current.intakeRunId) {
      return {
        state: 'AWAITING_REVIEW' as const,
        upload: safeUpload(current),
        replayed: true as const,
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
        ...scope,
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
    const claimed = await tx.intakeUpload.findFirst({ where: scope, select: uploadStateSelect })
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
    const current = await tx.intakeUpload.findFirst({ where: scope, select: uploadStateSelect })
    if (!current) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireUploadOwner(current, actor)
    if (current.status !== 'VERIFYING' || current.verificationClaimId !== claim.data)
      throw new IntakeUploadActionError('CONFLICT', 'Verification claim no longer owns this upload')
    const now = new Date()
    const leaseUntil = new Date(now.getTime() + INTAKE_UPLOAD_VERIFICATION_LEASE_MS)
    const changed = await tx.intakeUpload.updateMany({
      where: { ...scope, status: 'VERIFYING', verificationClaimId: claim.data },
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
    const current = await tx.intakeUpload.findFirst({ where: scope, select: uploadStateSelect })
    if (!current) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
    requireUploadOwner(current, actor)
    if (current.status !== 'VERIFYING' || current.verificationClaimId !== claim.data)
      throw new IntakeUploadActionError('CONFLICT', 'Verification claim no longer owns this upload')
    const now = new Date()
    if (!current.verificationLeaseUntil || current.verificationLeaseUntil <= now)
      throw new IntakeUploadActionError('CONFLICT', 'Verification claim lease expired')
    const changed = await tx.intakeUpload.updateMany({
      where: {
        ...scope,
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
    const settled = await tx.intakeUpload.findFirst({ where: scope, select: safeDetailSelect })
    if (!settled) throw new Error('Settled intake upload disappeared')
    return { upload: safeUpload(settled), retryable: false as const }
  })
}

export async function finalizeVerifiedIntakeUploadAction(input: {
  tenantId: string
  venueId: string
  uploadId: string
  actor: IntakeUploadActor
  claimId: string
  verified: IntakeUploadVerifiedTransportType
  client?: IntakeUploadActionClient
}) {
  if (!input || typeof input !== 'object')
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid verified upload settlement')
  const scope = parseScope(input)
  const actor = parseActor(input.actor)
  const claim = claimIdInput.safeParse(input.claimId)
  const verified = IntakeUploadVerifiedTransport.safeParse(input.verified)
  if (!claim.success || !verified.success)
    throw new IntakeUploadActionError('INVALID_INPUT', 'Invalid verified upload settlement')
  const client = input.client ?? db
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const upload = await tx.intakeUpload.findFirst({ where: scope, select: uploadStateSelect })
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
    if (upload.status === 'AWAITING_REVIEW' && upload.intakeRunId) {
      const replayedRun = await tx.intakeRun.findFirst({
        where: {
          id: upload.intakeRunId,
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          sourceKind: 'FILE_UPLOAD',
          status: 'AWAITING_REVIEW',
        },
        select: { id: true, status: true, sourceKind: true, createdAt: true },
      })
      if (!replayedRun)
        throw new IntakeUploadActionError(
          'CONFLICT',
          'Verified upload review proposal is inconsistent',
        )
      return {
        upload: safeUpload(upload),
        intakeRun: replayedRun,
        replayed: true as const,
        nextAction: 'PATHFINDER_REVIEW' as const,
        autoApprove: false as const,
        autoApply: false as const,
        published: false as const,
      }
    }
    if (upload.status !== 'VERIFYING' || upload.verificationClaimId !== claim.data)
      throw new IntakeUploadActionError('CONFLICT', 'Verification claim no longer owns this upload')
    const now = new Date()
    if (!upload.verificationLeaseUntil || upload.verificationLeaseUntil <= now)
      throw new IntakeUploadActionError('CONFLICT', 'Verification claim lease expired')
    const run = await tx.intakeRun.create({
      data: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        sourceKind: 'FILE_UPLOAD',
        status: 'AWAITING_REVIEW',
        displayName: upload.displayName,
        requestedBy: actor.id,
      },
      select: { id: true, status: true, sourceKind: true, createdAt: true },
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
    await tx.intakeRunEvent.create({
      data: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        runId: run.id,
        kind: 'PROPOSAL_CREATED',
        actorId: actor.id,
        metadata: { sourceKind: 'FILE_UPLOAD', autoApprove: false, autoApply: false },
      },
    })
    await tx.intakeRunEvent.create({
      data: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        runId: run.id,
        kind: 'EVIDENCE_RECORDED',
        actorId: actor.id,
        metadata: {
          evidenceKind: 'VERIFIED_QUARANTINED_FILE_HASH',
          mimeType: upload.mimeType,
          byteSize: upload.byteSize,
          transportVerified: true,
          formatVerified: false,
          malwareScanned: false,
        },
      },
    })
    const changed = await tx.intakeUpload.updateMany({
      where: {
        ...scope,
        status: 'VERIFYING',
        verificationClaimId: claim.data,
        verificationLeaseUntil: { gt: now },
        intakeRunId: null,
      },
      data: {
        status: 'AWAITING_REVIEW',
        verificationClaimId: null,
        verificationClaimedAt: null,
        verificationLeaseUntil: null,
        storageVersionId: verified.data.storageVersionId,
        verifiedAt: now,
        intakeRunId: run.id,
      },
    })
    if (changed.count !== 1)
      throw new IntakeUploadActionError('CONFLICT', 'Verification claim no longer owns this upload')
    await writeAuditLogStrict(
      {
        tenantId: scope.tenantId,
        actorId: actor.id,
        actorRole: actor.role,
        action: 'intake-upload.verified-for-review',
        targetType: 'IntakeUpload',
        targetId: upload.id,
        beforeState: { status: 'VERIFYING' },
        afterState: {
          venueId: scope.venueId,
          status: 'AWAITING_REVIEW',
          sourceKind: 'FILE_UPLOAD',
          mimeType: upload.mimeType,
          byteSize: upload.byteSize,
          autoApprove: false,
          autoApply: false,
          published: false,
        },
      },
      tx,
    )
    return {
      upload: {
        ...safeUpload(upload),
        status: 'AWAITING_REVIEW',
        intakeRunId: run.id,
        updatedAt: now,
      },
      intakeRun: run,
      replayed: false as const,
      nextAction: 'PATHFINDER_REVIEW' as const,
      autoApprove: false as const,
      autoApply: false as const,
      published: false as const,
    }
  })
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
    where: scope,
    select: safeDetailSelect,
  })
  if (!upload) throw new IntakeUploadActionError('NOT_FOUND', 'Intake upload not found')
  return upload
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}
