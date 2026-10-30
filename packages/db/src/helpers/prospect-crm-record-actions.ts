import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { db } from '../client'
import { saveProspectOutreachDraftAction } from './prospect-outreach-actions'

type Client = typeof db
type Reader = Pick<
  Parameters<Parameters<Client['$transaction']>[0]>[0],
  | 'prospectActivity'
  | 'prospectOutreachDraft'
  | 'prospectOutreachCampaign'
  | 'prospectCampaignMember'
>
export type CrmRecordChange =
  | {
      type: 'draft'
      draftId: string
      expectedVersion: number
      expectedContentHash: string
      action: 'edit' | 'discard'
      subject?: string | undefined
      textBody?: string | undefined
    }
  | {
      type: 'campaign'
      campaignId: string
      expectedUpdatedAt: string
      action: 'edit' | 'archive' | 'restore'
      name?: string | undefined
      description?: string | null | undefined
      dailyLimit?: number | undefined
    }
  | { type: 'member'; memberId: string; expectedUpdatedAt: string; action: 'remove' }
  | {
      type: 'note'
      organizationId: string
      noteId: string
      expectedRevision: string
      action: 'correct' | 'archive' | 'restore'
      text?: string | undefined
    }
type Note = {
  id: string
  organizationId: string
  summary: string
  detail: string | null
  occurredAt: Date
}
type Correction = { id: string; evidence: unknown; occurredAt: Date }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject
function conflict(message: string): never {
  throw Object.assign(new Error(message), { code: 'CONFLICT' })
}
export function projectProspectNoteLifecycle(note: Note, activities: readonly Correction[]) {
  const relevant = activities
    .filter((a) => {
      const e = a.evidence as Record<string, unknown> | null
      return e?.schema === 'crm-note-lifecycle/v1' && e.noteId === note.id
    })
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))
  let text = note.detail ?? note.summary,
    archived = false,
    corrected = false
  for (const activity of relevant) {
    const e = activity.evidence as Record<string, unknown>
    if (e.action === 'correct' && typeof e.text === 'string') {
      text = e.text
      corrected = true
    }
    if (e.action === 'archive') archived = true
    if (e.action === 'restore') archived = false
  }
  return {
    text,
    originalText: note.detail ?? note.summary,
    archived,
    corrected,
    revision: hash([note, relevant]),
  }
}
export async function readProspectNoteLifecycle(
  reader: Pick<Reader, 'prospectActivity'>,
  organizationId: string,
  noteId: string,
) {
  const note = await reader.prospectActivity.findFirst({
    where: { id: noteId, organizationId, type: 'NOTE_ADDED', summary: 'Operator note added' },
    select: { id: true, organizationId: true, summary: true, detail: true, occurredAt: true },
  })
  if (!note) throw Object.assign(new Error('Recorded note not found'), { code: 'NOT_FOUND' })
  const activities = await reader.prospectActivity.findMany({
    where: { organizationId, evidence: { path: ['noteId'], equals: noteId } },
    select: { id: true, evidence: true, occurredAt: true },
  })
  return { ...projectProspectNoteLifecycle(note, activities), note }
}
export async function readProspectCrmRecord(reader: Reader, record: CrmRecordChange) {
  if (record.type === 'note') {
    const note = await readProspectNoteLifecycle(reader, record.organizationId, record.noteId)
    return { revision: note.revision, state: note }
  }
  if (record.type === 'draft') {
    const draft = await reader.prospectOutreachDraft.findUnique({ where: { id: record.draftId } })
    if (!draft) return null
    return { revision: `${draft.version}:${draft.contentHash}`, state: draft }
  }
  if (record.type === 'campaign') {
    const campaign = await reader.prospectOutreachCampaign.findUnique({
      where: { id: record.campaignId },
    })
    if (!campaign) return null
    return { revision: campaign.updatedAt.toISOString(), state: campaign }
  }
  const member = await reader.prospectCampaignMember.findUnique({ where: { id: record.memberId } })
  return member ? { revision: member.updatedAt.toISOString(), state: member } : null
}
export const prospectCrmRecordExpectedRevision = (record: CrmRecordChange) =>
  record.type === 'note'
    ? record.expectedRevision
    : record.type === 'draft'
      ? `${record.expectedVersion}:${record.expectedContentHash}`
      : new Date(record.expectedUpdatedAt).toISOString()
export async function updateProspectCrmRecordAction(
  input: {
    record: CrmRecordChange
    reason: string
    operationId: string
    actor:
      | { type: 'HUMAN'; role: 'PLATFORM_ADMIN'; id: string }
      | { type: 'AGENT'; id: string; capabilities: readonly string[] }
  },
  client: Client = db,
) {
  if (
    !input.actor.id ||
    !input.reason.trim() ||
    (input.actor.type === 'HUMAN'
      ? input.actor.role !== 'PLATFORM_ADMIN'
      : !input.actor.capabilities.includes('prospects:crm:maintain'))
  )
    throw new Error('Authorized CRM maintenance actor and reason required')
  const receiptId = `crm-record:${input.operationId}`
  const requestHash = hash([input.record, input.reason, input.actor.id])
  const existing = await client.auditLog.findUnique({ where: { id: receiptId } })
  if (existing) {
    if ((existing.structuredReason as Record<string, unknown> | null)?.requestHash !== requestHash)
      conflict('Operation id already used with different content')
    return existing.afterState as Record<string, unknown>
  }
  const record = input.record
  if (record.type === 'draft' && record.action === 'edit') {
    const prior = await client.prospectOutreachDraft.findUnique({ where: { id: record.draftId } })
    if (
      !prior ||
      prior.version !== record.expectedVersion ||
      prior.contentHash !== record.expectedContentHash
    )
      conflict('Draft changed')
    const replay = await client.prospectOutreachDraft.findFirst({
      where: {
        memberId: prior.memberId,
        groundingSnapshot: { path: ['crmRecordOperationId'], equals: input.operationId },
      },
    })
    if (replay) {
      if (
        (replay.groundingSnapshot as Record<string, unknown>)?.crmRecordRequestHash !== requestHash
      )
        conflict('Operation id already used with different content')
      return {
        draftId: replay.id,
        status: replay.status,
        version: replay.version,
        contentHash: replay.contentHash,
      }
    }
    if (!['NEEDS_REVIEW', 'APPROVED', 'REJECTED'].includes(prior.status))
      conflict('Queued, sent or superseded draft cannot be edited')
    const snapshot =
      prior.groundingSnapshot &&
      typeof prior.groundingSnapshot === 'object' &&
      !Array.isArray(prior.groundingSnapshot)
        ? prior.groundingSnapshot
        : {}
    const saved = await saveProspectOutreachDraftAction(
      {
        memberId: prior.memberId,
        subject: record.subject ?? prior.subject,
        textBody: record.textBody ?? prior.textBody,
        groundingSnapshot: {
          ...snapshot,
          crmRecordOperationId: input.operationId,
          crmRecordRequestHash: requestHash,
        },
        expectedPreviousDraftId: prior.id,
        expectedPreviousVersion: record.expectedVersion,
        expectedPreviousContentHash: record.expectedContentHash,
        actor: input.actor,
      },
      client,
    )
    return {
      draftId: saved.id,
      status: saved.status,
      version: saved.version,
      contentHash: saved.contentHash,
    }
  }
  return client.$transaction(
    async (tx) => {
      const receipt = await tx.auditLog.findUnique({ where: { id: receiptId } })
      if (receipt) {
        if (
          (receipt.structuredReason as Record<string, unknown> | null)?.requestHash !== requestHash
        )
          conflict('Operation id already used with different content')
        return receipt.afterState as Record<string, unknown>
      }
      const before = await readProspectCrmRecord(tx, record)
      if (!before) throw Object.assign(new Error('CRM record not found'), { code: 'NOT_FOUND' })
      if (before.revision !== prospectCrmRecordExpectedRevision(record))
        conflict('CRM record changed; read its current revision')
      let result: Record<string, unknown>
      if (record.type === 'note') {
        const current = await readProspectNoteLifecycle(tx, record.organizationId, record.noteId)
        if (record.action === 'correct' && !record.text?.trim())
          throw new Error('A correction requires text')
        await tx.prospectActivity.create({
          data: {
            organizationId: record.organizationId,
            type: 'NOTE_ADDED',
            summary: `Recorded note ${record.action}`,
            actorId: input.actor.id,
            externalReceiptKey: receiptId,
            evidence: {
              schema: 'crm-note-lifecycle/v1',
              noteId: record.noteId,
              action: record.action,
              ...(record.text ? { text: record.text } : {}),
              reason: input.reason,
              previousRevision: current.revision,
            },
          },
        })
        const after = await readProspectNoteLifecycle(tx, record.organizationId, record.noteId)
        result = {
          noteId: record.noteId,
          revision: after.revision,
          archived: after.archived,
          corrected: after.corrected,
        }
      } else if (record.type === 'campaign') {
        const campaign = await tx.prospectOutreachCampaign.findUniqueOrThrow({
          where: { id: record.campaignId },
        })
        const snapshot =
          campaign.cohortSnapshot &&
          typeof campaign.cohortSnapshot === 'object' &&
          !Array.isArray(campaign.cohortSnapshot)
            ? campaign.cohortSnapshot
            : {}
        const marker = (snapshot as Record<string, unknown>).crmArchive as
          | Record<string, unknown>
          | undefined
        if (record.action === 'restore' && marker?.archived !== true)
          conflict('Campaign has no recorded archive to restore')
        const data: Prisma.ProspectOutreachCampaignUpdateManyMutationInput = {
          updatedBy: input.actor.id,
        }
        const terminal = ['COMPLETE', 'CANCELLED'].includes(campaign.status)
        const restoredTerminal =
          record.action === 'restore' &&
          ['COMPLETE', 'CANCELLED'].includes(String(marker?.previousStatus))
            ? (String(marker?.previousStatus) as 'COMPLETE' | 'CANCELLED')
            : null
        let resultingStatus = campaign.status
        if (record.action === 'edit') {
          if (record.name !== undefined) data.name = record.name
          if (record.description !== undefined) data.description = record.description
          if (record.dailyLimit !== undefined) data.dailySendCap = record.dailyLimit
        } else {
          resultingStatus =
            record.action === 'archive'
              ? terminal
                ? campaign.status
                : 'PAUSED'
              : (restoredTerminal ?? 'DRAFT')
          data.status = resultingStatus
          data.pausedAt = resultingStatus === 'PAUSED' ? new Date() : null
          data.cohortSnapshot = json({
            ...snapshot,
            crmArchive: {
              archived: record.action === 'archive',
              previousStatus:
                record.action === 'archive' && marker?.archived === true
                  ? marker.previousStatus
                  : campaign.status,
              reason: input.reason,
            },
          })
        }
        const changed = await tx.prospectOutreachCampaign.updateMany({
          where: { id: record.campaignId, updatedAt: new Date(record.expectedUpdatedAt) },
          data,
        })
        if (changed.count !== 1) conflict('Campaign changed')
        result = {
          campaignId: campaign.id,
          status: resultingStatus,
          archived:
            record.action === 'archive' || (record.action === 'edit' && marker?.archived === true),
        }
      } else if (record.type === 'member') {
        const member = await tx.prospectCampaignMember.findUniqueOrThrow({
          where: { id: record.memberId },
        })
        const unsafe = await tx.prospectSendItem.count({
          where: {
            memberId: member.id,
            status: { in: ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'DELAYED', 'AMBIGUOUS'] },
          },
        })
        const drafts = await tx.prospectOutreachDraft.count({
          where: { memberId: member.id, status: { in: ['NEEDS_REVIEW', 'APPROVED', 'QUEUED'] } },
        })
        if (unsafe || drafts || ['QUEUED', 'SENT', 'REPLIED', 'BOUNCED'].includes(member.status))
          conflict('Retain sent or uncertain member history; discard unsent drafts first')
        const changed = await tx.prospectCampaignMember.updateMany({
          where: { id: member.id, updatedAt: new Date(record.expectedUpdatedAt) },
          data: { status: 'CANCELLED' },
        })
        if (changed.count !== 1) conflict('Campaign member changed')
        result = { campaignMemberId: member.id, status: 'CANCELLED', retained: true }
      } else {
        const draft = await tx.prospectOutreachDraft.findUniqueOrThrow({
          where: { id: record.draftId },
        })
        if (!['NEEDS_REVIEW', 'APPROVED'].includes(draft.status))
          conflict(
            'Only unqueued unsent drafts can be discarded; queued or unknown sends require canonical cancellation',
          )
        const unsafe = await tx.prospectSendItem.count({
          where: { draftId: draft.id, status: { notIn: ['STAGED', 'CANCELLED'] } },
        })
        if (unsafe) conflict('Draft has sent, queued or uncertain provider work')
        const batches = await tx.prospectSendBatch.findMany({
          where: { status: { in: ['STAGED', 'APPROVED'] }, items: { some: { draftId: draft.id } } },
          select: { id: true },
        })
        const ids = batches.map((b) => b.id)
        await tx.prospectSendBatch.updateMany({
          where: { id: { in: ids }, status: { in: ['STAGED', 'APPROVED'] } },
          data: { status: 'CANCELLED', cancelledReason: `DRAFT_DISCARDED:${input.reason}` },
        })
        await tx.prospectSendItem.updateMany({
          where: { batchId: { in: ids }, status: 'STAGED' },
          data: { status: 'CANCELLED', lastErrorCode: 'DRAFT_DISCARDED' },
        })
        const changed = await tx.prospectOutreachDraft.updateMany({
          where: {
            id: draft.id,
            version: record.expectedVersion,
            contentHash: record.expectedContentHash,
            status: { in: ['NEEDS_REVIEW', 'APPROVED'] },
          },
          data: {
            status: 'REJECTED',
            rejectedReason: input.reason,
            approvedBy: null,
            approvedAt: null,
          },
        })
        if (changed.count !== 1) conflict('Draft changed')
        result = { draftId: draft.id, status: 'REJECTED', retained: true }
      }
      await tx.auditLog.create({
        data: {
          id: receiptId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          actorRole: input.actor.type === 'HUMAN' ? input.actor.role : 'AGENT',
          action: 'crm.record.update',
          targetType: record.type,
          targetId:
            record.type === 'note'
              ? record.noteId
              : record.type === 'campaign'
                ? record.campaignId
                : record.type === 'member'
                  ? record.memberId
                  : record.draftId,
          beforeState: json(before.state),
          afterState: json(result),
          structuredReason: { requestHash, reason: input.reason },
        },
      })
      return result
    },
    { isolationLevel: 'Serializable' },
  )
}
