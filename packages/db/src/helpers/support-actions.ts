import { createHash, randomUUID } from 'node:crypto'

import type {
  SupportAttachmentReference,
  SupportMessageVisibility,
  SupportRequestCategory,
} from '@pathfinder/contracts/support-workflow'
import {
  SupportAttachmentReferences,
  SupportMessageVisibility as SupportMessageVisibilitySchema,
  SupportRequestCategory as SupportRequestCategorySchema,
} from '@pathfinder/contracts/support-workflow'
import { z } from 'zod'
import { INTAKE_UPLOAD_MAX_BYTES, IntakeUploadMimeType } from '@pathfinder/contracts/intake-upload'
import { PreviewFeedbackContext } from '@pathfinder/contracts/client-package-preview'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { recordOrReplayOnboardingMilestoneEvent } from './onboarding-milestone-events'
import { canTenantActorAccessSupportRequest } from './support-request-access'

export type SupportActionActor =
  | {
      actorType: 'HUMAN'
      participantKind: 'CLIENT'
      actorId: string
      auditRole: string
    }
  | {
      actorType: 'HUMAN'
      participantKind: 'OPERATOR'
      actorId: string
      auditRole: string
    }
  | {
      actorType: 'AGENT'
      participantKind: 'AGENT'
      actorId: string
      auditRole: string
      agentIdentityId?: string | undefined
      agentRunId?: string | undefined
      workerId?: string | undefined
      credentialId?: string | undefined
      approvalGrantId?: string | undefined
      capability?:
        | 'support:draft'
        | 'support:note'
        | 'support:request-information'
        | 'support:complete'
        | undefined
      modelProvider?: string | undefined
      modelName?: string | undefined
      idempotencyKey?: string | undefined
    }
  | { actorType: 'SYSTEM'; participantKind: 'SYSTEM'; actorId: string; auditRole: string }

export type SupportAttachmentDraft = SupportAttachmentReference
type SupportActionClient = Pick<typeof db, '$transaction'>

const scopedId = z.string().trim().min(1).max(191)
const auditRole = z.string().trim().min(1).max(64)
const supportActionActor = z.union([
  z
    .object({
      actorType: z.literal('HUMAN'),
      participantKind: z.literal('CLIENT'),
      actorId: scopedId,
      auditRole: z.enum(['STAFF', 'MANAGER', 'OWNER']),
    })
    .strict(),
  z
    .object({
      actorType: z.literal('HUMAN'),
      participantKind: z.literal('OPERATOR'),
      actorId: scopedId,
      auditRole: z.literal('PLATFORM_ADMIN'),
    })
    .strict(),
  z
    .object({
      actorType: z.literal('AGENT'),
      participantKind: z.literal('AGENT'),
      actorId: scopedId,
      auditRole,
      agentIdentityId: scopedId.optional(),
      agentRunId: scopedId.optional(),
      workerId: scopedId.optional(),
      credentialId: scopedId.optional(),
      approvalGrantId: scopedId.optional(),
      capability: z
        .enum(['support:draft', 'support:note', 'support:request-information', 'support:complete'])
        .optional(),
      modelProvider: scopedId.optional(),
      modelName: scopedId.optional(),
      idempotencyKey: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      actorType: z.literal('SYSTEM'),
      participantKind: z.literal('SYSTEM'),
      actorId: scopedId,
      auditRole,
    })
    .strict(),
])
const createSupportRequestActionInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: scopedId,
    venueId: scopedId,
    category: SupportRequestCategorySchema,
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000),
    attachments: SupportAttachmentReferences,
    draftOnly: z.boolean().default(false),
    /** Trusted server-only lineage for a correction to an immutable intake source. */
    intakeSource: z
      .object({
        runId: scopedId,
        expectedEventCount: z.number().int().min(1).max(10_000),
      })
      .strict()
      .optional(),
    actor: supportActionActor,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actor.participantKind === 'AGENT' && !value.draftOnly) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['draftOnly'],
        message: 'Agent support requests must remain internal drafts',
      })
    }
    if (
      value.draftOnly &&
      (value.actor.participantKind !== 'AGENT' ||
        !value.actor.agentIdentityId ||
        !value.actor.agentRunId ||
        !value.actor.workerId ||
        !value.actor.credentialId ||
        !value.actor.approvalGrantId ||
        value.actor.capability !== 'support:draft' ||
        !value.actor.idempotencyKey)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actor'],
        message: 'Internal support drafts require complete machine lineage',
      })
    }
  })
const appendSupportMessageActionInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: scopedId,
    venueId: scopedId,
    requestId: scopedId,
    expectedVersion: z.number().int().positive().optional(),
    expectedClientVersion: z.number().int().positive().optional(),
    visibility: SupportMessageVisibilitySchema,
    body: z.string().trim().min(1).max(20_000),
    attachments: SupportAttachmentReferences,
    actor: supportActionActor,
  })
  .strict()
  .superRefine((value, context) => {
    const isClient = value.actor.participantKind === 'CLIENT'
    if (
      (isClient && value.expectedClientVersion === undefined) ||
      (!isClient && value.expectedVersion === undefined) ||
      (isClient && value.expectedVersion !== undefined) ||
      (!isClient && value.expectedClientVersion !== undefined)
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid support version field' })
    if (
      value.actor.participantKind === 'AGENT' &&
      (value.visibility !== 'INTERNAL_ONLY' ||
        value.attachments.length !== 0 ||
        !value.actor.agentIdentityId ||
        !value.actor.agentRunId ||
        !value.actor.workerId ||
        !value.actor.credentialId ||
        !value.actor.approvalGrantId ||
        value.actor.capability !== 'support:note' ||
        !value.actor.idempotencyKey)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actor'],
        message: 'Agent support notes require complete machine lineage and internal-only content',
      })
    }
  })
const createPreviewFeedbackRequestActionInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: scopedId,
    venueId: scopedId,
    packageId: scopedId,
    body: z.string().trim().min(1).max(20_000),
    context: PreviewFeedbackContext.default({ kind: 'GENERAL' }),
    attachments: SupportAttachmentReferences,
    actor: z
      .object({
        actorType: z.literal('HUMAN'),
        participantKind: z.literal('CLIENT'),
        actorId: scopedId,
        auditRole: z.enum(['STAFF', 'MANAGER', 'OWNER']),
      })
      .strict(),
  })
  .strict()

const operatorConversationActor = z
  .object({
    actorType: z.literal('HUMAN'),
    participantKind: z.literal('OPERATOR'),
    actorId: scopedId,
    auditRole: z.literal('PLATFORM_ADMIN'),
  })
  .strict()

const approvedClientVisibleSupportAgentActor = z
  .object({
    actorType: z.literal('AGENT'),
    participantKind: z.literal('AGENT'),
    actorId: scopedId,
    auditRole: z.literal('AGENT'),
    agentIdentityId: scopedId,
    agentRunId: scopedId,
    workerId: scopedId,
    credentialId: scopedId,
    approvalGrantId: scopedId,
    capability: z.enum(['support:request-information', 'support:complete']),
    modelProvider: scopedId.optional(),
    modelName: scopedId.optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict()
  .superRefine((actor, context) => {
    if ((actor.modelProvider === undefined) !== (actor.modelName === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelProvider'],
        message: 'Model provider and model name must be supplied together',
      })
    }
  })

const operatorConversationInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: scopedId,
    venueId: scopedId,
    requestId: scopedId,
    expectedVersion: z.number().int().positive(),
    body: z.string().trim().min(1).max(20_000),
    actor: z.union([
      operatorConversationActor,
      approvedClientVisibleSupportAgentActor.refine(
        (actor) => actor.capability === 'support:complete',
        'The exact support:complete capability is required',
      ),
    ]),
  })
  .strict()
const requestInformationInput = operatorConversationInput.extend({
  actor: z.union([
    operatorConversationActor,
    approvedClientVisibleSupportAgentActor.refine(
      (actor) => actor.capability === 'support:request-information',
      'The exact support:request-information capability is required',
    ),
  ]),
  missingInformation: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(30)
    .refine((items) => new Set(items).size === items.length, 'Items must be unique'),
})
const respondInformationInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: scopedId,
    venueId: scopedId,
    requestId: scopedId,
    expectedClientVersion: z.number().int().positive(),
    body: z.string().trim().min(1).max(20_000),
    attachments: SupportAttachmentReferences,
    actor: z
      .object({
        actorType: z.literal('HUMAN'),
        participantKind: z.literal('CLIENT'),
        actorId: scopedId,
        auditRole: z.enum(['STAFF', 'MANAGER', 'OWNER']),
      })
      .strict(),
  })
  .strict()

export class SupportActionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'SupportActionError'
  }
}

const requestSelect = {
  id: true,
  venueId: true,
  category: true,
  status: true,
  subject: true,
  missingInformation: true,
  version: true,
  clientVersion: true,
  clientActivityAt: true,
  statusChangedAt: true,
  createdAt: true,
  updatedAt: true,
} as const
const messageSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  supportRequestId: true,
  authorKind: true,
  authorId: true,
  visibility: true,
  body: true,
  clientVersion: true,
  createdAt: true,
  attachments: {
    select: {
      id: true,
      filename: true,
      mediaType: true,
      byteSize: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const

type ResolvedSupportAttachment = {
  intakeUploadId: string
  filename: string
  mediaType: string
  byteSize: number
}

function attachmentCreates(attachments: ResolvedSupportAttachment[]) {
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    byteSize: BigInt(attachment.byteSize),
    intakeUploadId: attachment.intakeUploadId,
  }))
}

function sameAttachmentReferences(
  references: SupportAttachmentDraft[],
  attachments: Array<{ intakeUploadId: string | null }>,
) {
  const expected = references.map(({ intakeUploadId }) => intakeUploadId).sort()
  const actual = attachments.map(({ intakeUploadId }) => intakeUploadId).sort()
  return expected.length === actual.length && expected.every((id, index) => id === actual[index])
}

async function lockSupportOperation(
  tx: Parameters<Parameters<SupportActionClient['$transaction']>[0]>[0],
  tenantId: string,
  operationId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:support-operation:${tenantId}:${operationId}`}, 0))`
}

async function lockSupportRequest(
  tx: Parameters<Parameters<SupportActionClient['$transaction']>[0]>[0],
  tenantId: string,
  requestId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:support-request:${tenantId}:${requestId}`}, 0))`
}

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

function supportSubmissionHash(value: Record<string, unknown>) {
  return createHash('sha256')
    .update(canonicalJson({ domain: 'pathfinder.support-message.v1', ...value }))
    .digest('hex')
}

const replayMessageSelect = {
  ...messageSelect,
  submissionRequestId: true,
  submissionInputHash: true,
  requestVersion: true,
  attachments: {
    select: {
      id: true,
      filename: true,
      mediaType: true,
      byteSize: true,
      intakeUploadId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const

function safeReplayMessage(message: {
  id: string
  tenantId: string
  venueId: string
  supportRequestId: string
  authorKind: string
  authorId: string
  visibility: string
  body: string
  createdAt: Date
  submissionRequestId: string | null
  submissionInputHash: string | null
  attachments: Array<{
    id: string
    filename: string
    mediaType: string
    byteSize: bigint
    intakeUploadId: string | null
    createdAt: Date
  }>
}) {
  return {
    id: message.id,
    tenantId: message.tenantId,
    venueId: message.venueId,
    supportRequestId: message.supportRequestId,
    authorKind: message.authorKind,
    authorId: message.authorId,
    visibility: message.visibility,
    body: message.body,
    createdAt: message.createdAt,
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      byteSize: attachment.byteSize,
      createdAt: attachment.createdAt,
    })),
  }
}

function parseActionInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new SupportActionError('INVALID_INPUT', 'Invalid support action input')
  }
  return parsed.data
}

async function resolveAttachments(
  tx: Parameters<Parameters<SupportActionClient['$transaction']>[0]>[0],
  scope: { tenantId: string; venueId: string; actor: SupportActionActor },
  references: SupportAttachmentDraft[],
): Promise<ResolvedSupportAttachment[]> {
  if (references.length === 0) return []
  const ids = references.map((reference) => reference.intakeUploadId)
  const uploads = await tx.intakeUpload.findMany({
    where: {
      id: { in: ids },
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      status: 'AWAITING_REVIEW',
      mimeType: { in: IntakeUploadMimeType.options },
      byteSize: { gte: 1, lte: INTAKE_UPLOAD_MAX_BYTES },
      verifiedAt: { not: null },
      storageVersionId: { not: null },
      intakeRunId: { not: null },
      intakeRun: { sourceKind: 'FILE_UPLOAD', status: 'AWAITING_REVIEW' },
      AND: [
        { verificationReceipts: { some: { kind: 'PRECHECK', verdict: 'PASSED' } } },
        { verificationReceipts: { some: { kind: 'RESOURCE_SAFETY', verdict: 'PASSED' } } },
        { verificationReceipts: { some: { kind: 'MALWARE', verdict: 'CLEAN' } } },
      ],
      ...(scope.actor.participantKind === 'CLIENT' ? { requestedBy: scope.actor.actorId } : {}),
    },
    select: {
      id: true,
      status: true,
      fileName: true,
      mimeType: true,
      byteSize: true,
      sha256: true,
      verifiedAt: true,
      storageVersionId: true,
      requestedBy: true,
      intakeRunId: true,
      intakeRun: {
        select: {
          id: true,
          sourceKind: true,
          status: true,
          evidence: {
            select: {
              tenantId: true,
              venueId: true,
              runId: true,
              sourceKind: true,
              locator: true,
              normalizedHash: true,
            },
          },
        },
      },
    },
  })
  const byId = new Map(uploads.map((upload) => [upload.id, upload]))
  if (uploads.length !== ids.length || ids.some((id) => !byId.has(id))) {
    throw new SupportActionError('NOT_FOUND', 'Verified support attachment not found')
  }
  return ids.map((id) => {
    const upload = byId.get(id)!
    if (
      upload.status !== 'AWAITING_REVIEW' ||
      !upload.intakeRunId ||
      !upload.verifiedAt ||
      !upload.storageVersionId ||
      upload.intakeRun?.id !== upload.intakeRunId ||
      upload.intakeRun.sourceKind !== 'FILE_UPLOAD' ||
      upload.intakeRun.status !== 'AWAITING_REVIEW' ||
      !IntakeUploadMimeType.safeParse(upload.mimeType).success ||
      upload.byteSize < 1 ||
      upload.byteSize > INTAKE_UPLOAD_MAX_BYTES ||
      upload.intakeRun.evidence.length !== 1 ||
      upload.intakeRun.evidence[0]?.tenantId !== scope.tenantId ||
      upload.intakeRun.evidence[0]?.venueId !== scope.venueId ||
      upload.intakeRun.evidence[0]?.runId !== upload.intakeRunId ||
      upload.intakeRun.evidence[0]?.sourceKind !== 'FILE_UPLOAD' ||
      upload.intakeRun.evidence[0]?.locator !== `intake-upload:${upload.id}` ||
      upload.intakeRun.evidence[0]?.normalizedHash !== upload.sha256 ||
      (scope.actor.participantKind === 'CLIENT' && upload.requestedBy !== scope.actor.actorId)
    ) {
      throw new SupportActionError('NOT_FOUND', 'Verified support attachment not found')
    }
    return {
      intakeUploadId: upload.id,
      filename: upload.fileName,
      mediaType: upload.mimeType,
      byteSize: upload.byteSize,
    }
  })
}

function assertVisibility(actor: SupportActionActor, visibility: SupportMessageVisibility) {
  if (actor.participantKind === 'CLIENT' && visibility === 'INTERNAL_ONLY')
    throw new SupportActionError('FORBIDDEN', 'Client-authored messages cannot be internal-only')
}

function appendEvidence(actor: SupportActionActor, visibility: SupportMessageVisibility) {
  if (actor.participantKind === 'CLIENT')
    return { eventType: 'CLIENT_MESSAGE_ADDED', action: 'support-request.client-message-added' }
  if (actor.participantKind === 'OPERATOR')
    return visibility === 'INTERNAL_ONLY'
      ? { eventType: 'INTERNAL_NOTE_ADDED', action: 'support-request.internal-note-added' }
      : { eventType: 'OPERATOR_MESSAGE_ADDED', action: 'support-request.operator-message-added' }
  if (actor.participantKind === 'AGENT')
    return visibility === 'INTERNAL_ONLY'
      ? {
          eventType: 'AGENT_INTERNAL_NOTE_ADDED',
          action: 'support-request.agent-internal-note-added',
        }
      : { eventType: 'AGENT_MESSAGE_ADDED', action: 'support-request.agent-message-added' }
  return visibility === 'INTERNAL_ONLY'
    ? {
        eventType: 'SYSTEM_INTERNAL_NOTE_ADDED',
        action: 'support-request.system-internal-note-added',
      }
    : { eventType: 'SYSTEM_MESSAGE_ADDED', action: 'support-request.system-message-added' }
}

async function createSupportRequestActionOnce(
  input: {
    tenantId: string
    operationId: string
    venueId: string
    category: SupportRequestCategory
    subject: string
    body: string
    attachments: SupportAttachmentDraft[]
    draftOnly?: boolean
    intakeSource?: { runId: string; expectedEventCount: number }
    actor: SupportActionActor
  },
  client: SupportActionClient = db,
) {
  const parsed = parseActionInput(createSupportRequestActionInput, input)
  const initialStatus = parsed.draftOnly ? ('DRAFT' as const) : ('OPEN' as const)
  const initialVisibility = parsed.draftOnly
    ? ('INTERNAL_ONLY' as const)
    : ('CLIENT_VISIBLE' as const)
  assertVisibility(parsed.actor, initialVisibility)
  const submissionInputHash = supportSubmissionHash({
    kind: 'CREATE_REQUEST',
    initialStatus,
    initialVisibility,
    actorKind: parsed.actor.participantKind,
    actorId: parsed.actor.actorId,
    tenantId: parsed.tenantId,
    venueId: parsed.venueId,
    category: parsed.category,
    subject: parsed.subject,
    body: parsed.body,
    intakeUploadIds: parsed.attachments.map(({ intakeUploadId }) => intakeUploadId).sort(),
    intakeSource: parsed.intakeSource ?? null,
  })
  return client.$transaction(async (tx) => {
    const replayQuery = {
      where: { tenantId: parsed.tenantId, submissionRequestId: parsed.operationId },
      select: {
        ...replayMessageSelect,
        supportRequest: { select: requestSelect },
      },
    } as const
    let existing = await tx.supportMessage.findFirst(replayQuery)
    await lockSupportOperation(tx, parsed.tenantId, parsed.operationId)
    if (parsed.actor.participantKind === 'CLIENT') {
      const membership = await tx.tenantMembership.findFirst({
        where: {
          tenantId: parsed.tenantId,
          userId: parsed.actor.actorId,
          status: 'ACTIVE',
        },
        select: { id: true },
      })
      if (!membership) throw new SupportActionError('NOT_FOUND', 'Venue not found')
    }
    if (!existing) existing = await tx.supportMessage.findFirst(replayQuery)
    if (existing) {
      if (
        existing.venueId !== parsed.venueId ||
        existing.submissionInputHash !== submissionInputHash ||
        existing.authorKind !== parsed.actor.participantKind ||
        existing.authorId !== parsed.actor.actorId ||
        existing.visibility !== initialVisibility ||
        existing.supportRequest.status !== initialStatus ||
        !sameAttachmentReferences(parsed.attachments, existing.attachments)
      ) {
        throw new SupportActionError('CONFLICT', 'Support operation ID was already used')
      }
      const { supportRequest, ...message } = existing
      return {
        request: supportRequest,
        message: safeReplayMessage(message),
        replayed: true as const,
      }
    }
    const venue = await tx.venue.findFirst({
      where: { id: parsed.venueId, tenantId: parsed.tenantId },
      select: { id: true },
    })
    if (!venue) throw new SupportActionError('NOT_FOUND', 'Venue not found')
    let intakeSource:
      | { id: string; sourceKind: string; displayName: string; eventCount: number }
      | undefined
    if (parsed.intakeSource) {
      const source = await tx.intakeRun.findFirst({
        where: {
          id: parsed.intakeSource.runId,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
        },
        select: {
          id: true,
          sourceKind: true,
          displayName: true,
          _count: { select: { events: true } },
        },
      })
      if (!source) throw new SupportActionError('NOT_FOUND', 'Intake source not found')
      if (source._count.events !== parsed.intakeSource.expectedEventCount)
        throw new SupportActionError(
          'CONFLICT',
          'The intake source changed. Refresh before submitting this correction.',
        )
      intakeSource = {
        id: source.id,
        sourceKind: source.sourceKind,
        displayName: source.displayName,
        eventCount: source._count.events,
      }
    }
    const attachments = await resolveAttachments(tx, parsed, parsed.attachments)
    const request = await tx.supportRequest.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        category: parsed.category,
        status: initialStatus,
        subject: parsed.subject,
        artifacts: intakeSource
          ? {
              schemaVersion: 1,
              kind: 'INTAKE_SOURCE_CORRECTION',
              intakeSource,
            }
          : {},
        createdByKind: parsed.actor.participantKind,
        createdById: parsed.actor.actorId,
        requesterUserId: parsed.actor.participantKind === 'CLIENT' ? parsed.actor.actorId : null,
        updatedByKind: parsed.actor.participantKind,
        updatedById: parsed.actor.actorId,
      },
      select: requestSelect,
    })
    const message = await tx.supportMessage.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: request.id,
        authorKind: parsed.actor.participantKind,
        authorId: parsed.actor.actorId,
        visibility: initialVisibility,
        body: parsed.body,
        submissionRequestId: parsed.operationId,
        submissionInputHash,
        clientVersion: parsed.draftOnly ? null : 1,
        attachments: {
          create: attachmentCreates(attachments),
        },
      },
      select: messageSelect,
    })
    await tx.supportRequestAuditEvent.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: request.id,
        requestVersion: request.version,
        eventType: parsed.draftOnly ? 'REQUEST_DRAFTED' : 'REQUEST_CREATED',
        actorKind: parsed.actor.participantKind,
        actorId: parsed.actor.actorId,
        fromStatus: null,
        toStatus: null,
      },
      select: { id: true },
    })
    const auditActor =
      parsed.actor.participantKind === 'AGENT'
        ? {
            actor: {
              type: 'AGENT' as const,
              actorId: parsed.actor.actorId,
              role: 'AGENT' as const,
              agentIdentityId: parsed.actor.agentIdentityId!,
              agentRunId: parsed.actor.agentRunId!,
              workerId: parsed.actor.workerId!,
              credentialId: parsed.actor.credentialId!,
              approvalGrantId: parsed.actor.approvalGrantId!,
              capability: parsed.actor.capability!,
              ...(parsed.actor.modelProvider ? { modelProvider: parsed.actor.modelProvider } : {}),
              ...(parsed.actor.modelName ? { modelName: parsed.actor.modelName } : {}),
              idempotencyKey: parsed.actor.idempotencyKey!,
            },
          }
        : {
            actorId: parsed.actor.actorId,
            actorRole: parsed.actor.auditRole,
            actorType: parsed.actor.actorType,
          }
    await writeAuditLogStrict(
      {
        tenantId: parsed.tenantId,
        ...auditActor,
        action: parsed.draftOnly ? 'support-request.created-draft' : 'support-request.created',
        targetType: 'SupportRequest',
        targetId: request.id,
        afterState: {
          venueId: request.venueId,
          category: request.category,
          status: request.status,
          messageVisibility: initialVisibility,
          version: request.version,
          attachmentCount: attachments.length,
          intakeSource: intakeSource
            ? { id: intakeSource.id, eventCount: intakeSource.eventCount }
            : null,
        },
      },
      tx,
    )
    if (intakeSource) {
      await recordOrReplayOnboardingMilestoneEvent({
        db: tx,
        input: {
          id: randomUUID(),
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          eventType: 'CORRECTION_RECORDED',
          idempotencyKey: `support-request:${request.id}:intake-source-correction`,
          occurredAt: request.createdAt,
          actorType: parsed.actor.participantKind,
          actorId: parsed.actor.actorId,
          sourceType: 'INTAKE_SOURCE',
          sourceId: intakeSource.id,
          sourceRevision: String(intakeSource.eventCount),
          category: parsed.category,
          durationMs: null,
        },
      })
    }
    return { request, message, replayed: false as const }
  })
}

function isUniqueConflict(error: unknown): error is { code: 'P2002' } {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

export async function createSupportRequestAction(
  input: Parameters<typeof createSupportRequestActionOnce>[0],
  client: SupportActionClient = db,
) {
  try {
    return await createSupportRequestActionOnce(input, client)
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    try {
      return await createSupportRequestActionOnce(input, client)
    } catch (replayError) {
      if (isUniqueConflict(replayError))
        throw new SupportActionError('CONFLICT', 'Support operation could not be reconciled')
      throw replayError
    }
  }
}

type SupportTransaction = Parameters<Parameters<SupportActionClient['$transaction']>[0]>[0]

export type PreviewFeedbackEligibilityAssertion = (
  tx: SupportTransaction,
  scope: { tenantId: string; venueId: string; packageId: string },
) => Promise<void>

async function createPreviewFeedbackRequestActionOnce(
  input: {
    operationId: string
    tenantId: string
    venueId: string
    packageId: string
    body: string
    context?: z.input<typeof PreviewFeedbackContext>
    attachments: SupportAttachmentDraft[]
    actor: {
      actorType: 'HUMAN'
      participantKind: 'CLIENT'
      actorId: string
      auditRole: string
    }
  },
  assertEligible: PreviewFeedbackEligibilityAssertion,
  client: SupportActionClient,
) {
  const parsed = parseActionInput(createPreviewFeedbackRequestActionInput, input)
  const feedbackContext = parsed.context ?? ({ kind: 'GENERAL' } as const)
  const submissionInputHash = supportSubmissionHash({
    kind: 'CREATE_APPROVED_PREVIEW_FEEDBACK_REQUEST',
    actorKind: parsed.actor.participantKind,
    actorId: parsed.actor.actorId,
    tenantId: parsed.tenantId,
    venueId: parsed.venueId,
    packageId: parsed.packageId,
    body: parsed.body,
    context: feedbackContext,
    intakeUploadIds: parsed.attachments.map(({ intakeUploadId }) => intakeUploadId).sort(),
  })
  return client.$transaction(
    async (tx) => {
      const replayQuery = {
        where: { tenantId: parsed.tenantId, submissionRequestId: parsed.operationId },
        select: {
          ...replayMessageSelect,
          supportRequest: { select: requestSelect },
          previewFeedback: {
            select: { id: true, venuePackageId: true, createdAt: true, createdById: true },
          },
        },
      } as const
      let existing = await tx.supportMessage.findFirst(replayQuery)
      await lockSupportOperation(tx, parsed.tenantId, parsed.operationId)
      const membership = await tx.tenantMembership.findFirst({
        where: {
          tenantId: parsed.tenantId,
          userId: parsed.actor.actorId,
          status: 'ACTIVE',
        },
        select: { id: true },
      })
      if (!membership)
        throw new SupportActionError('NOT_FOUND', 'Approved client preview not found')
      if (!existing) existing = await tx.supportMessage.findFirst(replayQuery)
      if (existing) {
        if (
          existing.venueId !== parsed.venueId ||
          existing.submissionInputHash !== submissionInputHash ||
          existing.authorKind !== 'CLIENT' ||
          existing.authorId !== parsed.actor.actorId ||
          existing.visibility !== 'CLIENT_VISIBLE' ||
          existing.previewFeedback?.venuePackageId !== parsed.packageId ||
          existing.previewFeedback.createdById !== parsed.actor.actorId ||
          !sameAttachmentReferences(parsed.attachments, existing.attachments)
        )
          throw new SupportActionError('CONFLICT', 'Support operation ID was already used')
        const { supportRequest, previewFeedback, ...message } = existing
        return {
          request: supportRequest,
          message: safeReplayMessage(message),
          feedback: {
            packageId: previewFeedback.venuePackageId,
            createdAt: previewFeedback.createdAt,
          },
          replayed: true as const,
        }
      }
      const pkg = await tx.venuePackage.findFirst({
        where: {
          id: parsed.packageId,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          status: 'APPROVED',
        },
        select: { id: true },
      })
      if (!pkg) throw new SupportActionError('NOT_FOUND', 'Approved client preview not found')
      await assertEligible(tx, {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        packageId: parsed.packageId,
      })
      const attachments = await resolveAttachments(tx, parsed, parsed.attachments)
      const request = await tx.supportRequest.create({
        data: {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          category: 'EXPERIENCE_BEHAVIOR',
          subject:
            feedbackContext.kind === 'PREVIEW_ANSWER'
              ? 'Feedback on a preview answer'
              : 'Feedback on approved preview',
          artifacts: {
            schemaVersion: 1,
            kind: 'CLIENT_PREVIEW_FEEDBACK',
            context: feedbackContext,
          },
          createdByKind: 'CLIENT',
          createdById: parsed.actor.actorId,
          requesterUserId: parsed.actor.actorId,
          updatedByKind: 'CLIENT',
          updatedById: parsed.actor.actorId,
        },
        select: requestSelect,
      })
      const message = await tx.supportMessage.create({
        data: {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          supportRequestId: request.id,
          authorKind: 'CLIENT',
          authorId: parsed.actor.actorId,
          visibility: 'CLIENT_VISIBLE',
          body: parsed.body,
          submissionRequestId: parsed.operationId,
          submissionInputHash,
          clientVersion: 1,
          attachments: {
            create: attachmentCreates(attachments),
          },
        },
        select: messageSelect,
      })
      const feedback = await tx.supportPreviewFeedback.create({
        data: {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          supportRequestId: request.id,
          supportMessageId: message.id,
          venuePackageId: parsed.packageId,
          createdByKind: 'CLIENT',
          createdById: parsed.actor.actorId,
        },
        select: { venuePackageId: true, createdAt: true },
      })
      await tx.supportRequestAuditEvent.create({
        data: {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          supportRequestId: request.id,
          requestVersion: request.version,
          eventType: 'PREVIEW_FEEDBACK_REQUEST_CREATED',
          actorKind: 'CLIENT',
          actorId: parsed.actor.actorId,
          fromStatus: null,
          toStatus: null,
        },
        select: { id: true },
      })
      await writeAuditLogStrict(
        {
          tenantId: parsed.tenantId,
          actorId: parsed.actor.actorId,
          actorRole: parsed.actor.auditRole,
          action: 'support-request.preview-feedback-created',
          targetType: 'SupportRequest',
          targetId: request.id,
          afterState: {
            venueId: request.venueId,
            venuePackageId: parsed.packageId,
            category: request.category,
            status: request.status,
            version: request.version,
            attachmentCount: attachments.length,
          },
        },
        tx,
      )
      return {
        request,
        message,
        feedback: { packageId: feedback.venuePackageId, createdAt: feedback.createdAt },
        replayed: false as const,
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}

export async function createPreviewFeedbackRequestAction(
  input: Parameters<typeof createPreviewFeedbackRequestActionOnce>[0],
  options: { assertEligible: PreviewFeedbackEligibilityAssertion },
  client: SupportActionClient = db,
) {
  if (!options || typeof options.assertEligible !== 'function')
    throw new SupportActionError('INVALID_INPUT', 'Preview eligibility assertion is required')
  try {
    return await createPreviewFeedbackRequestActionOnce(input, options.assertEligible, client)
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    try {
      return await createPreviewFeedbackRequestActionOnce(input, options.assertEligible, client)
    } catch (replayError) {
      if (isUniqueConflict(replayError))
        throw new SupportActionError('CONFLICT', 'Support operation could not be reconciled')
      throw replayError
    }
  }
}

async function appendSupportMessageActionOnce(
  input: {
    tenantId: string
    operationId: string
    venueId: string
    requestId: string
    expectedVersion?: number
    expectedClientVersion?: number
    visibility: SupportMessageVisibility
    body: string
    attachments: SupportAttachmentDraft[]
    actor: SupportActionActor
  },
  client: SupportActionClient = db,
) {
  const parsed = parseActionInput(appendSupportMessageActionInput, input)
  assertVisibility(parsed.actor, parsed.visibility)
  const submissionInputHash = supportSubmissionHash({
    kind: 'APPEND_MESSAGE',
    actorKind: parsed.actor.participantKind,
    actorId: parsed.actor.actorId,
    tenantId: parsed.tenantId,
    venueId: parsed.venueId,
    requestId: parsed.requestId,
    expectedVersion:
      parsed.actor.participantKind === 'CLIENT'
        ? parsed.expectedClientVersion
        : parsed.expectedVersion,
    visibility: parsed.visibility,
    body: parsed.body,
    intakeUploadIds: parsed.attachments.map(({ intakeUploadId }) => intakeUploadId).sort(),
  })
  return client.$transaction(async (tx) => {
    const replayQuery = {
      where: { tenantId: parsed.tenantId, submissionRequestId: parsed.operationId },
      select: replayMessageSelect,
    } as const
    await lockSupportOperation(tx, parsed.tenantId, parsed.operationId)
    await lockSupportRequest(tx, parsed.tenantId, parsed.requestId)
    const request = await tx.supportRequest.findFirst({
      where: { id: parsed.requestId, tenantId: parsed.tenantId, venueId: parsed.venueId },
      select: {
        id: true,
        status: true,
        version: true,
        clientVersion: true,
        createdByKind: true,
        requesterUserId: true,
        requesterMembership: { select: { status: true } },
        participants: {
          where: { userId: parsed.actor.actorId },
          select: {
            userId: true,
            revokedAt: true,
            membership: { select: { status: true } },
          },
        },
      },
    })
    if (!request) throw new SupportActionError('NOT_FOUND', 'Support request not found')
    if (
      parsed.actor.participantKind === 'CLIENT' &&
      !canTenantActorAccessSupportRequest(
        { actorId: parsed.actor.actorId, role: parsed.actor.auditRole },
        request,
      )
    )
      throw new SupportActionError('NOT_FOUND', 'Support request not found')
    const existingMessage = await tx.supportMessage.findFirst(replayQuery)
    if (existingMessage) {
      if (
        existingMessage.venueId !== parsed.venueId ||
        existingMessage.supportRequestId !== parsed.requestId ||
        existingMessage.submissionInputHash !== submissionInputHash ||
        existingMessage.authorKind !== parsed.actor.participantKind ||
        existingMessage.authorId !== parsed.actor.actorId ||
        existingMessage.visibility !== parsed.visibility ||
        !sameAttachmentReferences(parsed.attachments, existingMessage.attachments)
      ) {
        throw new SupportActionError('CONFLICT', 'Support operation ID was already used')
      }
      return {
        message: safeReplayMessage(existingMessage),
        requestVersion:
          parsed.actor.participantKind === 'CLIENT' ? request.version : parsed.expectedVersion! + 1,
        clientVersion:
          parsed.actor.participantKind === 'CLIENT'
            ? existingMessage.clientVersion!
            : request.clientVersion,
        replayed: true as const,
      }
    }
    if (
      parsed.actor.participantKind !== 'OPERATOR' &&
      (request.status === 'COMPLETED' || request.status === 'CANCELLED')
    )
      throw new SupportActionError('CONFLICT', 'This support request is closed')
    if (
      (parsed.actor.participantKind === 'CLIENT' &&
        request.clientVersion !== parsed.expectedClientVersion) ||
      (parsed.actor.participantKind !== 'CLIENT' && request.version !== parsed.expectedVersion)
    )
      throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    const attachments = await resolveAttachments(tx, parsed, parsed.attachments)
    const nextVersion = request.version + 1
    const changed = await tx.supportRequest.updateMany({
      where: {
        id: request.id,
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        ...(parsed.actor.participantKind === 'CLIENT'
          ? { clientVersion: parsed.expectedClientVersion!, version: request.version }
          : { version: parsed.expectedVersion! }),
      },
      data: {
        version: nextVersion,
        ...(parsed.visibility === 'CLIENT_VISIBLE'
          ? { clientVersion: request.clientVersion + 1, clientActivityAt: new Date() }
          : {}),
        updatedByKind: parsed.actor.participantKind,
        updatedById: parsed.actor.actorId,
      },
    })
    if (changed.count !== 1)
      throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    const message = await tx.supportMessage.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: request.id,
        authorKind: parsed.actor.participantKind,
        authorId: parsed.actor.actorId,
        visibility: parsed.visibility,
        body: parsed.body,
        submissionRequestId: parsed.operationId,
        submissionInputHash,
        clientVersion: parsed.visibility === 'CLIENT_VISIBLE' ? request.clientVersion + 1 : null,
        attachments: {
          create: attachmentCreates(attachments),
        },
      },
      select: messageSelect,
    })
    const evidence = appendEvidence(parsed.actor, parsed.visibility)
    await tx.supportRequestAuditEvent.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: request.id,
        requestVersion: nextVersion,
        eventType: evidence.eventType,
        actorKind: parsed.actor.participantKind,
        actorId: parsed.actor.actorId,
        fromStatus: null,
        toStatus: null,
      },
      select: { id: true },
    })
    const auditEvidence = {
      tenantId: parsed.tenantId,
      action: evidence.action,
      targetType: 'SupportRequest',
      targetId: request.id,
      beforeState: { version: request.version },
      afterState: {
        version: nextVersion,
        attachmentCount: attachments.length,
        ...(parsed.actor.participantKind === 'OPERATOR' ? { visibility: parsed.visibility } : {}),
        ...(parsed.actor.participantKind === 'AGENT'
          ? {
              visibility: 'INTERNAL_ONLY',
              customerContacted: false,
              participantGranted: false,
              statusChanged: false,
              triageChanged: false,
              packageLifecycleChanged: false,
              executionTriggered: false,
            }
          : {}),
      },
    }
    if (parsed.actor.participantKind === 'AGENT') {
      await writeAuditLogStrict(
        {
          ...auditEvidence,
          actor: {
            type: 'AGENT' as const,
            role: 'AGENT',
            actorId: parsed.actor.actorId,
            agentIdentityId: parsed.actor.agentIdentityId!,
            agentRunId: parsed.actor.agentRunId!,
            workerId: parsed.actor.workerId!,
            credentialId: parsed.actor.credentialId!,
            approvalGrantId: parsed.actor.approvalGrantId!,
            capability: parsed.actor.capability!,
            ...(parsed.actor.modelProvider ? { modelProvider: parsed.actor.modelProvider } : {}),
            ...(parsed.actor.modelName ? { modelName: parsed.actor.modelName } : {}),
            idempotencyKey: parsed.actor.idempotencyKey!,
          },
        },
        tx,
      )
    } else {
      await writeAuditLogStrict(
        {
          ...auditEvidence,
          actorId: parsed.actor.actorId,
          actorRole: parsed.actor.auditRole,
          actorType: parsed.actor.actorType,
        },
        tx,
      )
    }
    return {
      message,
      requestVersion: nextVersion,
      clientVersion:
        parsed.visibility === 'CLIENT_VISIBLE' ? request.clientVersion + 1 : request.clientVersion,
      replayed: false as const,
    }
  })
}

export async function appendSupportMessageAction(
  input: Parameters<typeof appendSupportMessageActionOnce>[0],
  client: SupportActionClient = db,
) {
  try {
    return await appendSupportMessageActionOnce(input, client)
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    try {
      return await appendSupportMessageActionOnce(input, client)
    } catch (replayError) {
      if (isUniqueConflict(replayError))
        throw new SupportActionError('CONFLICT', 'Support operation could not be reconciled')
      throw replayError
    }
  }
}

type ManualLoopKind = 'REQUEST_INFORMATION' | 'RESPOND_INFORMATION' | 'COMPLETE_REQUEST'
type ManualLoopParsed = {
  operationId: string
  tenantId: string
  venueId: string
  requestId: string
  expectedVersion?: number
  expectedClientVersion?: number
  body: string
  missingInformation?: string[]
  attachments?: SupportAttachmentDraft[]
  actor: SupportActionActor
}

async function manualSupportLoopActionOnce(
  kind: ManualLoopKind,
  input: unknown,
  client: SupportActionClient,
) {
  const parsed = (
    kind === 'REQUEST_INFORMATION'
      ? parseActionInput(requestInformationInput, input)
      : kind === 'RESPOND_INFORMATION'
        ? parseActionInput(respondInformationInput, input)
        : parseActionInput(operatorConversationInput, input)
  ) as ManualLoopParsed
  const isClient = kind === 'RESPOND_INFORMATION'
  const attachments: SupportAttachmentDraft[] = isClient ? (parsed.attachments ?? []) : []
  const requestedItems = kind === 'REQUEST_INFORMATION' ? (parsed.missingInformation ?? []) : []
  const expectedVersion = 'expectedVersion' in parsed ? parsed.expectedVersion : undefined
  const expectedClientVersion =
    'expectedClientVersion' in parsed ? parsed.expectedClientVersion : undefined
  const targetStatus =
    kind === 'REQUEST_INFORMATION'
      ? 'WAITING_FOR_CLIENT'
      : kind === 'RESPOND_INFORMATION'
        ? 'IN_REVIEW'
        : 'COMPLETED'
  const operationHash = supportSubmissionHash({
    kind,
    actorKind: parsed.actor.participantKind,
    actorId: parsed.actor.actorId,
    tenantId: parsed.tenantId,
    venueId: parsed.venueId,
    requestId: parsed.requestId,
    expectedVersion: expectedVersion ?? expectedClientVersion,
    body: parsed.body,
    missingInformation: requestedItems,
    intakeUploadIds: attachments.map(({ intakeUploadId }) => intakeUploadId).sort(),
  })

  return client.$transaction(async (tx) => {
    await lockSupportOperation(tx, parsed.tenantId, parsed.operationId)
    await lockSupportRequest(tx, parsed.tenantId, parsed.requestId)
    const request = await tx.supportRequest.findFirst({
      where: { id: parsed.requestId, tenantId: parsed.tenantId, venueId: parsed.venueId },
      select: {
        id: true,
        status: true,
        missingInformation: true,
        version: true,
        clientVersion: true,
        createdByKind: true,
        requesterUserId: true,
        requesterMembership: { select: { status: true } },
        participants: {
          where: { userId: parsed.actor.actorId },
          select: {
            userId: true,
            revokedAt: true,
            membership: { select: { status: true } },
          },
        },
      },
    })
    if (!request) throw new SupportActionError('NOT_FOUND', 'Support request not found')
    if (
      isClient &&
      !canTenantActorAccessSupportRequest(
        {
          actorId: parsed.actor.actorId,
          role: parsed.actor.auditRole as 'STAFF' | 'MANAGER' | 'OWNER',
        },
        request,
      )
    )
      throw new SupportActionError('NOT_FOUND', 'Support request not found')

    const replay = await tx.supportMessage.findFirst({
      where: { tenantId: parsed.tenantId, submissionRequestId: parsed.operationId },
      select: replayMessageSelect,
    })
    if (replay) {
      if (
        replay.venueId !== parsed.venueId ||
        replay.supportRequestId !== parsed.requestId ||
        replay.submissionInputHash !== operationHash ||
        replay.authorKind !== parsed.actor.participantKind ||
        replay.authorId !== parsed.actor.actorId ||
        replay.visibility !== 'CLIENT_VISIBLE' ||
        !sameAttachmentReferences(attachments, replay.attachments)
      )
        throw new SupportActionError('CONFLICT', 'Support operation ID was already used')
      if (replay.requestVersion === null || replay.clientVersion === null)
        throw new SupportActionError('CONFLICT', 'Support operation evidence is incomplete')
      return {
        message: safeReplayMessage(replay),
        status: targetStatus,
        missingInformation: requestedItems,
        requestVersion: replay.requestVersion,
        clientVersion: replay.clientVersion,
        replayed: true as const,
      }
    }

    if (kind === 'REQUEST_INFORMATION') {
      if (request.status !== 'OPEN' && request.status !== 'IN_REVIEW')
        throw new SupportActionError('CONFLICT', 'Request is not ready for an information prompt')
      if (request.version !== expectedVersion)
        throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    } else if (kind === 'RESPOND_INFORMATION') {
      if (request.status !== 'WAITING_FOR_CLIENT')
        throw new SupportActionError('CONFLICT', 'Request is not waiting for client information')
      if (request.missingInformation.length === 0)
        throw new SupportActionError('CONFLICT', 'No requested information remains to answer')
      if (request.clientVersion !== expectedClientVersion)
        throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    } else {
      if (request.status !== 'OPEN' && request.status !== 'IN_REVIEW')
        throw new SupportActionError('CONFLICT', 'Request is not ready for manual completion')
      if (request.missingInformation.length > 0)
        throw new SupportActionError('CONFLICT', 'Requested information must be resolved first')
      if (request.version !== expectedVersion)
        throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    }

    const resolvedAttachments = await resolveAttachments(tx, parsed, attachments)
    const now = new Date()
    const nextVersion = request.version + 1
    const nextClientVersion = request.clientVersion + 1
    const changed = await tx.supportRequest.updateMany({
      where: {
        id: request.id,
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        version: request.version,
        status: request.status,
        ...(isClient ? { clientVersion: expectedClientVersion! } : {}),
      },
      data: {
        status: targetStatus,
        missingInformation: requestedItems,
        statusChangedAt: now,
        version: nextVersion,
        clientVersion: nextClientVersion,
        clientActivityAt: now,
        updatedByKind: parsed.actor.participantKind,
        updatedById: parsed.actor.actorId,
      },
    })
    if (changed.count !== 1)
      throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    const message = await tx.supportMessage.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: request.id,
        authorKind: parsed.actor.participantKind,
        authorId: parsed.actor.actorId,
        visibility: 'CLIENT_VISIBLE',
        body: parsed.body,
        submissionRequestId: parsed.operationId,
        submissionInputHash: operationHash,
        clientVersion: nextClientVersion,
        requestVersion: nextVersion,
        createdAt: now,
        attachments: {
          create: attachmentCreates(resolvedAttachments),
        },
      },
      select: messageSelect,
    })
    const evidence =
      kind === 'REQUEST_INFORMATION'
        ? {
            eventType: 'INFORMATION_REQUESTED',
            action: 'support-request.information-requested',
          }
        : kind === 'RESPOND_INFORMATION'
          ? {
              eventType: 'REQUESTED_INFORMATION_RESPONDED',
              action: 'support-request.information-responded',
            }
          : { eventType: 'MANUALLY_COMPLETED', action: 'support-request.manually-completed' }
    await tx.supportRequestAuditEvent.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: request.id,
        requestVersion: nextVersion,
        eventType: evidence.eventType,
        actorKind: parsed.actor.participantKind,
        actorId: parsed.actor.actorId,
        fromStatus: request.status,
        toStatus: targetStatus,
      },
      select: { id: true },
    })
    const auditEvidence = {
      tenantId: parsed.tenantId,
      action: evidence.action,
      targetType: 'SupportRequest',
      targetId: request.id,
      beforeState: {
        status: request.status,
        version: request.version,
        missingInformationCount: request.missingInformation.length,
      },
      afterState: {
        status: targetStatus,
        version: nextVersion,
        missingInformationCount: requestedItems.length,
        attachmentCount: resolvedAttachments.length,
        clientVisibleMessageCreated: true,
        customerContacted: kind !== 'RESPOND_INFORMATION',
        externalDeliveryTriggered: false,
        emailSent: false,
        participantChanged: false,
        triageChanged: false,
        packageLifecycleChanged: false,
        executionTriggered: false,
      },
    }
    if (parsed.actor.actorType === 'AGENT') {
      await writeAuditLogStrict(
        {
          ...auditEvidence,
          actor: {
            type: 'AGENT',
            actorId: parsed.actor.actorId,
            role: 'AGENT',
            agentIdentityId: parsed.actor.agentIdentityId!,
            agentRunId: parsed.actor.agentRunId!,
            workerId: parsed.actor.workerId!,
            credentialId: parsed.actor.credentialId!,
            approvalGrantId: parsed.actor.approvalGrantId!,
            capability: parsed.actor.capability!,
            ...(parsed.actor.modelProvider ? { modelProvider: parsed.actor.modelProvider } : {}),
            ...(parsed.actor.modelName ? { modelName: parsed.actor.modelName } : {}),
            idempotencyKey: parsed.actor.idempotencyKey!,
          },
        },
        tx,
      )
    } else {
      await writeAuditLogStrict(
        {
          ...auditEvidence,
          actorId: parsed.actor.actorId,
          actorRole: parsed.actor.auditRole,
          actorType: parsed.actor.actorType,
        },
        tx,
      )
    }
    return {
      message,
      status: targetStatus,
      missingInformation: requestedItems,
      requestVersion: nextVersion,
      clientVersion: nextClientVersion,
      replayed: false as const,
    }
  })
}

async function replaySafeManualSupportLoop(
  kind: ManualLoopKind,
  input: unknown,
  client: SupportActionClient,
) {
  try {
    return await manualSupportLoopActionOnce(kind, input, client)
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    try {
      return await manualSupportLoopActionOnce(kind, input, client)
    } catch (replayError) {
      if (isUniqueConflict(replayError))
        throw new SupportActionError('CONFLICT', 'Support operation could not be reconciled')
      throw replayError
    }
  }
}

export function requestSupportInformationAction(
  input: z.input<typeof requestInformationInput>,
  client: SupportActionClient = db,
) {
  return replaySafeManualSupportLoop('REQUEST_INFORMATION', input, client)
}

export function respondToSupportInformationAction(
  input: z.input<typeof respondInformationInput>,
  client: SupportActionClient = db,
) {
  return replaySafeManualSupportLoop('RESPOND_INFORMATION', input, client)
}

export function completeSupportRequestAction(
  input: z.input<typeof operatorConversationInput>,
  client: SupportActionClient = db,
) {
  return replaySafeManualSupportLoop('COMPLETE_REQUEST', input, client)
}
