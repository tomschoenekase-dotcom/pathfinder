import type { InputJsonValue } from '@prisma/client/runtime/library'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type MediaIngestionHumanActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export type MediaIngestionActionClient = Pick<typeof db, '$transaction'>
export type MediaIngestionActionErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATUS'
  | 'INVALID_INPUT'

export class MediaIngestionActionError extends Error {
  constructor(
    readonly code: MediaIngestionActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MediaIngestionActionError'
  }
}

type Scope = {
  tenantId: string
  venueId: string
  projectId: string
  actor: MediaIngestionHumanActor
}

type CreateScope = Omit<Scope, 'projectId'>

const MAX_REVIEW_JSON_BYTES = 5_000_000

function requireCreateScope(input: CreateScope): void {
  if (
    input.actor.type !== 'HUMAN' ||
    input.actor.role !== 'PLATFORM_ADMIN' ||
    !input.actor.id ||
    !input.tenantId ||
    !input.venueId
  ) {
    throw new MediaIngestionActionError(
      'INVALID_INPUT',
      'An exact media scope and human platform administrator are required',
    )
  }
}

function requireScope(input: Scope): void {
  if (
    input.actor.type !== 'HUMAN' ||
    input.actor.role !== 'PLATFORM_ADMIN' ||
    !input.actor.id ||
    !input.tenantId ||
    !input.venueId ||
    !input.projectId
  ) {
    throw new MediaIngestionActionError(
      'INVALID_INPUT',
      'An exact media scope and human platform administrator are required',
    )
  }
}

function conflict(message = 'The media project changed; refresh and try again.'): never {
  throw new MediaIngestionActionError('CONFLICT', message)
}

function auditState(value: {
  status: string
  stage: string
  uploadAttemptId?: string | null
  updatedAt?: Date
}) {
  return {
    status: value.status,
    stage: value.stage,
    uploadAttemptId: value.uploadAttemptId ?? null,
    ...(value.updatedAt ? { updatedAt: value.updatedAt.toISOString() } : {}),
  }
}

async function run<T>(
  client: MediaIngestionActionClient,
  operation: (tx: typeof db) => Promise<T>,
): Promise<T> {
  return client.$transaction((rawTx) => operation(rawTx as unknown as typeof db))
}

function requireJsonPayload(value: unknown, label: string): InputJsonValue {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new MediaIngestionActionError('INVALID_INPUT', `${label} must be valid JSON`)
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_REVIEW_JSON_BYTES) {
    throw new MediaIngestionActionError('INVALID_INPUT', `${label} exceeds the safety limit`)
  }
  return value as InputJsonValue
}

export async function createMediaIngestionProjectAction(
  input: CreateScope & {
    name: string
    context: string
    mode: 'ECONOMY' | 'BALANCED' | 'FORENSIC'
    settings: {
      transcribeAudio: boolean
      preserveVerbatimText: boolean
      detectDuplicates: boolean
      requireEveryImage: boolean
      videoSecondsPerSample: number
    }
  },
  client: MediaIngestionActionClient = db,
) {
  requireCreateScope(input)
  if (
    typeof input.name !== 'string' ||
    input.name.trim().length < 1 ||
    input.name.length > 160 ||
    typeof input.context !== 'string' ||
    input.context.length > 30_000 ||
    !['ECONOMY', 'BALANCED', 'FORENSIC'].includes(input.mode) ||
    typeof input.settings.transcribeAudio !== 'boolean' ||
    typeof input.settings.preserveVerbatimText !== 'boolean' ||
    typeof input.settings.detectDuplicates !== 'boolean' ||
    typeof input.settings.requireEveryImage !== 'boolean' ||
    !Number.isInteger(input.settings.videoSecondsPerSample) ||
    input.settings.videoSecondsPerSample < 1 ||
    input.settings.videoSecondsPerSample > 60
  ) {
    throw new MediaIngestionActionError('INVALID_INPUT', 'Media project input is invalid')
  }
  return run(client, async (tx) => {
    const venue = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (!venue) throw new MediaIngestionActionError('NOT_FOUND', 'Venue not found')
    const project = await tx.mediaIngestionProject.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        name: input.name,
        context: input.context,
        mode: input.mode,
        settings: input.settings,
        createdBy: input.actor.id,
      },
      select: { id: true, status: true, stage: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.media_ingestion.created',
        targetType: 'MediaIngestionProject',
        targetId: project.id,
        afterState: auditState(project),
      },
      tx,
    )
    return { id: project.id }
  })
}

export async function claimMediaUploadFinalizationAction(
  input: Scope & { uploadAttemptId: string },
  client: MediaIngestionActionClient = db,
) {
  requireScope(input)
  return run(client, async (tx) => {
    const current = await tx.mediaIngestionProject.findFirst({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'UPLOADING',
        stage: 'upload',
        uploadAttemptId: input.uploadAttemptId,
      },
      select: { status: true, stage: true, uploadAttemptId: true, updatedAt: true },
    })
    if (!current) {
      throw new MediaIngestionActionError('NOT_FOUND', 'Active upload not found')
    }
    const changed = await tx.mediaIngestionProject.updateMany({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'UPLOADING',
        stage: 'upload',
        uploadAttemptId: input.uploadAttemptId,
        updatedAt: current.updatedAt,
      },
      data: { stage: 'finalizing', error: null },
    })
    if (changed.count !== 1) conflict('This upload is already being finalized.')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.media_ingestion.upload_finalization_claimed',
        targetType: 'MediaIngestionProject',
        targetId: input.projectId,
        beforeState: auditState(current),
        afterState: auditState({
          status: 'UPLOADING',
          stage: 'finalizing',
          uploadAttemptId: input.uploadAttemptId,
        }),
      },
      tx,
    )
    return { ok: true as const }
  })
}

export async function queueVerifiedMediaUploadAction(
  input: Scope & { uploadAttemptId: string; verifiedBytes: number },
  client: MediaIngestionActionClient = db,
) {
  requireScope(input)
  if (!Number.isSafeInteger(input.verifiedBytes) || input.verifiedBytes <= 0) {
    throw new MediaIngestionActionError('INVALID_INPUT', 'Verified byte count is invalid')
  }
  return run(client, async (tx) => {
    const current = await tx.mediaIngestionProject.findFirst({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        uploadAttemptId: input.uploadAttemptId,
      },
      select: {
        status: true,
        stage: true,
        sourceBytes: true,
        uploadAttemptId: true,
        uploadStartedAt: true,
        updatedAt: true,
      },
    })
    if (!current) throw new MediaIngestionActionError('NOT_FOUND', 'Media project not found')
    const exactReplay =
      (current.status === 'QUEUED' ||
        ['INVENTORYING', 'ANALYZING', 'SYNTHESIZING'].includes(current.status)) &&
      current.sourceBytes === BigInt(input.verifiedBytes)
    if (exactReplay) {
      return {
        ok: true as const,
        replayed: true as const,
        state: current.status as 'QUEUED' | 'INVENTORYING' | 'ANALYZING' | 'SYNTHESIZING',
      }
    }
    if (current.status !== 'UPLOADING' || current.stage !== 'finalizing') {
      throw new MediaIngestionActionError('INVALID_STATUS', 'Upload is not awaiting finalization')
    }
    const changed = await tx.mediaIngestionProject.updateMany({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'UPLOADING',
        stage: 'finalizing',
        uploadAttemptId: input.uploadAttemptId,
        updatedAt: current.updatedAt,
      },
      data: {
        status: 'QUEUED',
        stage: 'inventory',
        progress: 1,
        sourceBytes: BigInt(input.verifiedBytes),
        uploadStartedAt: null,
        storageUploadId: null,
        sourceContentType: null,
      },
    })
    if (changed.count !== 1) conflict('The upload state changed before completion was recorded.')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.media_ingestion.upload_completed',
        targetType: 'MediaIngestionProject',
        targetId: input.projectId,
        beforeState: auditState(current),
        afterState: auditState({
          status: 'QUEUED',
          stage: 'inventory',
          uploadAttemptId: input.uploadAttemptId,
        }),
      },
      tx,
    )
    return { ok: true as const, replayed: false as const, state: 'QUEUED' as const }
  })
}

export async function claimMediaUploadAbortAction(
  input: Scope & {
    uploadAttemptId: string
    expectedUploadStartedAt?: Date
    expectedSourceObjectKey?: string
    expectedStorageUploadId?: string
    expectedStage?: 'upload' | 'aborting'
  },
  client: MediaIngestionActionClient = db,
) {
  requireScope(input)
  return run(client, async (tx) => {
    const current = await tx.mediaIngestionProject.findFirst({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'UPLOADING',
        stage: { in: ['upload', 'aborting'] },
        uploadAttemptId: input.uploadAttemptId,
      },
      select: {
        status: true,
        stage: true,
        uploadAttemptId: true,
        uploadStartedAt: true,
        sourceObjectKey: true,
        storageUploadId: true,
        updatedAt: true,
      },
    })
    if (!current?.sourceObjectKey || !current.storageUploadId) {
      throw new MediaIngestionActionError('NOT_FOUND', 'Active upload not found')
    }
    if (
      (input.expectedSourceObjectKey !== undefined &&
        current.sourceObjectKey !== input.expectedSourceObjectKey) ||
      (input.expectedStorageUploadId !== undefined &&
        current.storageUploadId !== input.expectedStorageUploadId) ||
      (input.expectedUploadStartedAt !== undefined &&
        current.uploadStartedAt?.getTime() !== input.expectedUploadStartedAt.getTime()) ||
      (input.expectedStage !== undefined && current.stage !== input.expectedStage)
    ) {
      conflict('The upload identity changed.')
    }
    if (current.stage === 'aborting') {
      return {
        sourceObjectKey: current.sourceObjectKey,
        storageUploadId: current.storageUploadId,
        resumed: true as const,
      }
    }
    const changed = await tx.mediaIngestionProject.updateMany({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'UPLOADING',
        stage: 'upload',
        uploadAttemptId: input.uploadAttemptId,
        updatedAt: current.updatedAt,
        ...(input.expectedUploadStartedAt !== undefined
          ? { uploadStartedAt: input.expectedUploadStartedAt }
          : {}),
      },
      data: { stage: 'aborting', error: null },
    })
    if (changed.count !== 1) conflict('The upload state already changed.')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.media_ingestion.upload_abort_claimed',
        targetType: 'MediaIngestionProject',
        targetId: input.projectId,
        beforeState: auditState(current),
        afterState: auditState({
          status: 'UPLOADING',
          stage: 'aborting',
          uploadAttemptId: input.uploadAttemptId,
        }),
      },
      tx,
    )
    return {
      sourceObjectKey: current.sourceObjectKey,
      storageUploadId: current.storageUploadId,
      resumed: false as const,
    }
  })
}

export async function completeMediaUploadAbortAction(
  input: Scope & {
    uploadAttemptId: string
    sourceObjectKey: string
    storageUploadId: string
    auditAction: 'admin.media_ingestion.upload_aborted' | 'admin.media_ingestion.upload_expired'
  },
  client: MediaIngestionActionClient = db,
) {
  requireScope(input)
  return run(client, async (tx) => {
    const current = await tx.mediaIngestionProject.findFirst({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'UPLOADING',
        stage: 'aborting',
        uploadAttemptId: input.uploadAttemptId,
        sourceObjectKey: input.sourceObjectKey,
        storageUploadId: input.storageUploadId,
      },
      select: { status: true, stage: true, uploadAttemptId: true, updatedAt: true },
    })
    if (!current) conflict('The abort result could not be recorded.')
    const changed = await tx.mediaIngestionProject.updateMany({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'UPLOADING',
        stage: 'aborting',
        uploadAttemptId: input.uploadAttemptId,
        sourceObjectKey: input.sourceObjectKey,
        storageUploadId: input.storageUploadId,
        updatedAt: current.updatedAt,
      },
      data: {
        status: 'CANCELLED',
        stage: 'cancelled',
        uploadAttemptId: null,
        uploadStartedAt: null,
        storageUploadId: null,
        sourceObjectGeneration: null,
        sourceContentType: null,
        error: null,
      },
    })
    if (changed.count !== 1) conflict('The abort result could not be recorded.')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: input.auditAction,
        targetType: 'MediaIngestionProject',
        targetId: input.projectId,
        beforeState: auditState(current),
        afterState: auditState({ status: 'CANCELLED', stage: 'cancelled' }),
      },
      tx,
    )
    return { ok: true as const }
  })
}

export async function saveMediaIngestionReviewAction(
  input: Scope & {
    reviewGeneration: string | null
    expectedUpdatedAt: Date
    questions: unknown
    findings: unknown
    draftJson: unknown
    status: 'NEEDS_INPUT' | 'READY_FOR_REVIEW'
    stage: 'questions' | 'review'
  },
  client: MediaIngestionActionClient = db,
) {
  requireScope(input)
  if (
    !(input.expectedUpdatedAt instanceof Date) ||
    Number.isNaN(input.expectedUpdatedAt.getTime())
  ) {
    throw new MediaIngestionActionError('INVALID_INPUT', 'A valid expected revision is required')
  }
  if (
    !(
      (input.status === 'NEEDS_INPUT' && input.stage === 'questions') ||
      (input.status === 'READY_FOR_REVIEW' && input.stage === 'review')
    )
  ) {
    throw new MediaIngestionActionError('INVALID_INPUT', 'Review status and stage are inconsistent')
  }
  const questions = requireJsonPayload(input.questions, 'Review questions')
  const findings = requireJsonPayload(input.findings, 'Review findings')
  const draftJson = requireJsonPayload(input.draftJson, 'Review draft')
  return run(client, async (tx) => {
    const current = await tx.mediaIngestionProject.findFirst({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: { in: ['NEEDS_INPUT', 'READY_FOR_REVIEW'] },
      },
      select: {
        status: true,
        stage: true,
        uploadAttemptId: true,
        sourceObjectGeneration: true,
        updatedAt: true,
      },
    })
    if (!current) {
      throw new MediaIngestionActionError('NOT_FOUND', 'Reviewable media project not found')
    }
    if (current.sourceObjectGeneration !== input.reviewGeneration) {
      conflict('The media source generation changed.')
    }
    if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) conflict()
    const nextUpdatedAt = new Date(Math.max(Date.now(), input.expectedUpdatedAt.getTime() + 1))
    const changed = await tx.mediaIngestionProject.updateMany({
      where: {
        id: input.projectId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: { in: ['NEEDS_INPUT', 'READY_FOR_REVIEW'] },
        sourceObjectGeneration: input.reviewGeneration,
        updatedAt: input.expectedUpdatedAt,
      },
      data: {
        questions,
        findings,
        draftJson,
        status: input.status,
        stage: input.stage,
        updatedAt: nextUpdatedAt,
      },
    })
    if (changed.count !== 1) conflict()
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.media_ingestion.review_saved',
        targetType: 'MediaIngestionProject',
        targetId: input.projectId,
        beforeState: auditState(current),
        afterState: auditState({
          status: input.status,
          stage: input.stage,
          uploadAttemptId: current.uploadAttemptId,
          updatedAt: nextUpdatedAt,
        }),
      },
      tx,
    )
    return { ok: true as const, updatedAt: nextUpdatedAt }
  })
}
