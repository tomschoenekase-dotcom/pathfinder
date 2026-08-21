import { parseVerifiedActorContext } from '@pathfinder/contracts/actor'
import type { VerifiedActorContext } from '@pathfinder/contracts/actor'
import type { CompanyMeetingExtractionType, Prisma } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type CompanyMeetingActionClient = Pick<typeof db, '$transaction'>

export class CompanyMeetingActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'INVALID_SCOPE',
    message: string,
  ) {
    super(message)
    this.name = 'CompanyMeetingActionError'
  }
}

async function verifyMeetingScope(
  tx: typeof db,
  input: { tenantId?: string; venueId?: string; organizationId?: string; opportunityId?: string },
) {
  if (input.venueId && !input.tenantId) {
    throw new CompanyMeetingActionError('INVALID_SCOPE', 'Meeting venue requires tenant scope')
  }
  if (input.venueId && input.tenantId) {
    const venue = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (!venue) throw new CompanyMeetingActionError('NOT_FOUND', 'Venue not found in meeting scope')
  }
  if (input.organizationId) {
    const organization = await tx.prospectOrganization.findFirst({
      where: {
        id: input.organizationId,
        archivedAt: null,
        ...(input.tenantId
          ? { customerRelationships: { some: { tenantId: input.tenantId, status: 'ACTIVE' } } }
          : {}),
      },
      select: { id: true },
    })
    if (!organization) {
      throw new CompanyMeetingActionError('NOT_FOUND', 'Organization not found in meeting scope')
    }
  }
  if (input.opportunityId && input.organizationId) {
    const opportunity = await tx.prospectOpportunity.findFirst({
      where: { id: input.opportunityId, organizationId: input.organizationId },
      select: { id: true },
    })
    if (!opportunity) {
      throw new CompanyMeetingActionError('NOT_FOUND', 'Opportunity not found for organization')
    }
  }
}

export async function ingestCompanyMeetingAction(
  input: {
    tenantId?: string
    venueId?: string
    organizationId?: string
    opportunityId?: string
    externalProvider?: string
    externalId?: string
    title: string
    meetingType: string
    startedAt: Date
    endedAt?: Date
    sourceArtifactRef?: string
    transcriptStatus?:
      | 'UNAVAILABLE'
      | 'REFERENCED'
      | 'AVAILABLE'
      | 'RETAINED_EXTERNALLY'
      | 'REDACTED'
    participants?: Array<{
      contactId?: string
      displayName?: string
      role?: string
      externalRef?: string
      isTorchiko?: boolean
    }>
    idempotencyKey: string
    actor: VerifiedActorContext
  },
  client: CompanyMeetingActionClient = db,
) {
  const actor = parseVerifiedActorContext(input.actor)
  if (actor.type === 'AGENT') {
    throw new CompanyMeetingActionError(
      'FORBIDDEN',
      'Meeting ingestion requires human, system, or integration authority',
    )
  }
  if (!input.title.trim() || !input.meetingType.trim()) {
    throw new CompanyMeetingActionError('CONFLICT', 'Meeting title and type are required')
  }
  if (input.endedAt && input.endedAt < input.startedAt) {
    throw new CompanyMeetingActionError('CONFLICT', 'Meeting end must not precede start')
  }
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const existing = await tx.companyMeeting.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, processingStatus: true },
    })
    if (existing) return { ...existing, replayed: true }
    await verifyMeetingScope(tx, input)
    const meeting = await tx.companyMeeting.create({
      data: {
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        ...(input.venueId ? { venueId: input.venueId } : {}),
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
        ...(input.externalProvider ? { externalProvider: input.externalProvider } : {}),
        ...(input.externalId ? { externalId: input.externalId } : {}),
        title: input.title.trim(),
        meetingType: input.meetingType.trim(),
        startedAt: input.startedAt,
        ...(input.endedAt ? { endedAt: input.endedAt } : {}),
        ...(input.sourceArtifactRef ? { sourceArtifactRef: input.sourceArtifactRef } : {}),
        transcriptStatus: input.transcriptStatus ?? 'UNAVAILABLE',
        processingStatus: 'RECEIVED',
        processingProvenance: {
          ingestedByType: actor.type,
          ingestedById: actor.actorId,
          integrationId: actor.integrationId,
        },
        idempotencyKey: input.idempotencyKey,
        ...(input.participants?.length
          ? {
              participants: {
                create: input.participants.map((participant) => ({
                  ...(input.tenantId ? { tenantId: input.tenantId } : {}),
                  ...(participant.contactId ? { contactId: participant.contactId } : {}),
                  ...(participant.displayName ? { displayName: participant.displayName } : {}),
                  ...(participant.role ? { role: participant.role } : {}),
                  ...(participant.externalRef ? { externalRef: participant.externalRef } : {}),
                  isTorchiko: participant.isTorchiko ?? false,
                })),
              },
            }
          : {}),
      },
      select: { id: true, processingStatus: true },
    })
    await writeAuditLogStrict(
      {
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        actor,
        action: 'company-meeting.ingested',
        targetType: 'CompanyMeeting',
        targetId: meeting.id,
        idempotencyKey: input.idempotencyKey,
        sourceReferences: input.sourceArtifactRef ? [{ ref: input.sourceArtifactRef }] : [],
        afterState: { processingStatus: meeting.processingStatus },
      },
      tx,
    )
    return { ...meeting, replayed: false }
  })
}

export async function recordCompanyMeetingExtractionAction(
  input: {
    meetingId: string
    tenantId?: string
    type: CompanyMeetingExtractionType
    content: string
    structuredData?: Prisma.InputJsonValue
    confidence?: number
    sourceStartOffset?: number
    sourceEndOffset?: number
    idempotencyKey: string
    actor: VerifiedActorContext
  },
  client: CompanyMeetingActionClient = db,
) {
  const actor = parseVerifiedActorContext(input.actor)
  if (actor.type === 'AGENT' && actor.capability !== 'meetings.process') {
    throw new CompanyMeetingActionError('FORBIDDEN', 'Machine actor requires meetings.process')
  }
  if (!input.content.trim()) {
    throw new CompanyMeetingActionError('CONFLICT', 'Meeting extraction content is required')
  }
  if (
    input.sourceStartOffset !== undefined &&
    input.sourceEndOffset !== undefined &&
    input.sourceEndOffset < input.sourceStartOffset
  ) {
    throw new CompanyMeetingActionError('CONFLICT', 'Extraction source offsets are invalid')
  }
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const existing = await tx.companyMeetingExtraction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, promotionStatus: true },
    })
    if (existing) return { ...existing, replayed: true }
    const meeting = await tx.companyMeeting.findFirst({
      where: {
        id: input.meetingId,
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      },
      select: { id: true, tenantId: true, organizationId: true, processingStatus: true },
    })
    if (!meeting) throw new CompanyMeetingActionError('NOT_FOUND', 'Meeting not found in scope')
    const extraction = await tx.companyMeetingExtraction.create({
      data: {
        ...(meeting.tenantId ? { tenantId: meeting.tenantId } : {}),
        meetingId: meeting.id,
        type: input.type,
        content: input.content.trim(),
        structuredData: input.structuredData ?? {},
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        promotionStatus: 'CANDIDATE',
        ...(input.sourceStartOffset !== undefined
          ? { sourceStartOffset: input.sourceStartOffset }
          : {}),
        ...(input.sourceEndOffset !== undefined ? { sourceEndOffset: input.sourceEndOffset } : {}),
        createdByType: actor.type,
        createdById: actor.actorId,
        ...(actor.modelProvider ? { modelProvider: actor.modelProvider } : {}),
        ...(actor.modelName ? { modelName: actor.modelName } : {}),
        idempotencyKey: input.idempotencyKey,
      },
      select: { id: true, promotionStatus: true },
    })
    await writeAuditLogStrict(
      {
        ...(meeting.tenantId ? { tenantId: meeting.tenantId } : {}),
        actor,
        action: 'company-meeting.extraction-recorded',
        targetType: 'CompanyMeetingExtraction',
        targetId: extraction.id,
        idempotencyKey: input.idempotencyKey,
        structuredReason: { meetingId: meeting.id, type: input.type },
        sourceReferences: [{ type: 'MEETING', id: meeting.id }],
        afterState: { promotionStatus: extraction.promotionStatus },
      },
      tx,
    )
    return { ...extraction, replayed: false }
  })
}

export async function completeCompanyMeetingProcessingAction(
  input: {
    meetingId: string
    tenantId?: string
    summary: string
    provenance: Prisma.InputJsonValue
    actor: VerifiedActorContext
  },
  client: CompanyMeetingActionClient = db,
) {
  const actor = parseVerifiedActorContext(input.actor)
  if (actor.type === 'AGENT' && actor.capability !== 'meetings.process') {
    throw new CompanyMeetingActionError('FORBIDDEN', 'Machine actor requires meetings.process')
  }
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const meeting = await tx.companyMeeting.findFirst({
      where: {
        id: input.meetingId,
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      },
      select: { id: true, tenantId: true, processingStatus: true },
    })
    if (!meeting) throw new CompanyMeetingActionError('NOT_FOUND', 'Meeting not found in scope')
    if (meeting.processingStatus === 'COMPLETE') return { ...meeting, replayed: true }
    const completed = await tx.companyMeeting.update({
      where: { id: meeting.id },
      data: {
        summary: input.summary.trim(),
        processingStatus: 'COMPLETE',
        processingProvenance: input.provenance,
        processedAt: new Date(),
        failureCode: null,
        failureMessage: null,
      },
      select: { id: true, tenantId: true, processingStatus: true },
    })
    await writeAuditLogStrict(
      {
        ...(meeting.tenantId ? { tenantId: meeting.tenantId } : {}),
        actor,
        action: 'company-meeting.processing-completed',
        targetType: 'CompanyMeeting',
        targetId: meeting.id,
        beforeState: { processingStatus: meeting.processingStatus },
        afterState: { processingStatus: completed.processingStatus },
      },
      tx,
    )
    return { ...completed, replayed: false }
  })
}
