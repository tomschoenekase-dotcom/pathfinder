import {
  AccountHistoryRequest,
  AccountMeetingGetRequest,
} from '@pathfinder/contracts/company-brain'

import { db } from '../client'

export class AccountHistoryError extends Error {
  constructor(
    readonly code: 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'AccountHistoryError'
  }
}

export type AccountHistoryClient = Pick<
  typeof db,
  | 'prospectOrganization'
  | 'prospectActivity'
  | 'prospectEmailMessage'
  | 'companyMeeting'
  | 'accountMilestone'
  | 'supportRequest'
>

async function resolveOrganization(
  input: { clientId: string; organizationId?: string | undefined },
  client: Pick<typeof db, 'prospectOrganization'>,
) {
  const organization = await client.prospectOrganization.findFirst({
    where: {
      ...(input.organizationId ? { id: input.organizationId } : {}),
      archivedAt: null,
      customerRelationships: { some: { tenantId: input.clientId, status: 'ACTIVE' } },
    },
    select: { id: true, canonicalName: true },
  })
  if (!organization) {
    throw new AccountHistoryError('NOT_FOUND', 'Account not found in verified client scope')
  }
  return organization
}

function page<T extends { occurredAt: string }>(items: T[], limit: number) {
  const ordered = items
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, limit)
  const last = ordered.at(-1)
  return {
    items: ordered,
    nextBefore:
      items.length > limit && last
        ? new Date(new Date(last.occurredAt).getTime() - 1).toISOString()
        : null,
  }
}

function snippet(value: string | null, max = 320) {
  if (!value) return null
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`
}

function gmailSourceLink(mailboxAddress: string, internetMessageId: string) {
  return `https://mail.google.com/mail/u/${encodeURIComponent(mailboxAddress)}/#search/${encodeURIComponent(`rfc822msgid:${internetMessageId}`)}`
}

export async function getAccountTimeline(
  rawInput: AccountHistoryRequest,
  client: AccountHistoryClient = db,
) {
  const input = AccountHistoryRequest.parse(rawInput)
  const organization = await resolveOrganization(input, client)
  const before = input.before ? new Date(input.before) : undefined
  const take = input.limit + 1
  const [activities, messages, meetings, milestones, support] = await Promise.all([
    client.prospectActivity.findMany({
      where: { organizationId: organization.id, ...(before ? { occurredAt: { lt: before } } : {}) },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, type: true, summary: true, detail: true, occurredAt: true },
    }),
    client.prospectEmailMessage.findMany({
      where: { organizationId: organization.id, ...(before ? { occurredAt: { lt: before } } : {}) },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, direction: true, status: true, subject: true, occurredAt: true },
    }),
    client.companyMeeting.findMany({
      where: {
        organizationId: organization.id,
        tenantId: input.clientId,
        ...(input.venueId ? { venueId: input.venueId } : {}),
        ...(before ? { startedAt: { lt: before } } : {}),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, title: true, meetingType: true, summary: true, startedAt: true },
    }),
    client.accountMilestone.findMany({
      where: {
        organizationId: organization.id,
        AND: [
          { OR: [{ tenantId: null }, { tenantId: input.clientId }] },
          ...(input.venueId ? [{ OR: [{ venueId: null }, { venueId: input.venueId }] }] : []),
        ],
        ...(before ? { occurredAt: { lt: before } } : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        type: true,
        summary: true,
        occurredAt: true,
        sourceType: true,
        sourceId: true,
      },
    }),
    client.supportRequest.findMany({
      where: {
        tenantId: input.clientId,
        ...(input.venueId ? { venueId: input.venueId } : {}),
        ...(before ? { updatedAt: { lt: before } } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        venueId: true,
        category: true,
        status: true,
        subject: true,
        updatedAt: true,
      },
    }),
  ])

  const merged = [
    ...activities.map((item) => ({
      id: item.id,
      kind: 'CRM_ACTIVITY' as const,
      title: item.summary,
      detail: item.detail ?? item.type,
      occurredAt: item.occurredAt.toISOString(),
      provenance: { sourceType: 'OPERATIONAL_RECORD', sourceId: item.id },
    })),
    ...messages.map((item) => ({
      id: item.id,
      kind: 'CORRESPONDENCE' as const,
      title: item.subject,
      detail: `${item.direction}:${item.status}`,
      occurredAt: item.occurredAt.toISOString(),
      provenance: { sourceType: 'EMAIL', sourceId: item.id },
    })),
    ...meetings.map((item) => ({
      id: item.id,
      kind: 'MEETING' as const,
      title: item.title,
      detail: snippet(item.summary) ?? item.meetingType,
      occurredAt: item.startedAt.toISOString(),
      provenance: { sourceType: 'MEETING', sourceId: item.id },
    })),
    ...milestones.map((item) => ({
      id: item.id,
      kind: 'MILESTONE' as const,
      title: item.summary ?? item.type,
      detail: item.type,
      occurredAt: item.occurredAt.toISOString(),
      provenance: { sourceType: item.sourceType, sourceId: item.sourceId ?? item.id },
    })),
    ...support.map((item) => ({
      id: item.id,
      kind: 'SUPPORT' as const,
      title: item.subject,
      detail: `${item.status}:${item.category}`,
      occurredAt: item.updatedAt.toISOString(),
      provenance: { sourceType: 'SUPPORT_THREAD', sourceId: item.id, venueId: item.venueId },
    })),
  ]
  return {
    schemaVersion: 'account-timeline.v1',
    organization,
    generatedAt: new Date().toISOString(),
    ...page(merged, input.limit),
  }
}

export async function listAccountMeetings(
  rawInput: AccountHistoryRequest,
  client: Pick<typeof db, 'prospectOrganization' | 'companyMeeting'> = db,
) {
  const input = AccountHistoryRequest.parse(rawInput)
  const organization = await resolveOrganization(input, client)
  const before = input.before ? new Date(input.before) : undefined
  const rows = await client.companyMeeting.findMany({
    where: {
      tenantId: input.clientId,
      organizationId: organization.id,
      ...(input.venueId ? { venueId: input.venueId } : {}),
      ...(before ? { startedAt: { lt: before } } : {}),
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    select: {
      id: true,
      title: true,
      meetingType: true,
      startedAt: true,
      endedAt: true,
      summary: true,
      transcriptStatus: true,
      processingStatus: true,
      processedAt: true,
      _count: { select: { participants: true, extractions: true } },
    },
  })
  const result = page(
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      meetingType: row.meetingType,
      occurredAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      summary: row.summary,
      transcriptStatus: row.transcriptStatus,
      processingStatus: row.processingStatus,
      processedAt: row.processedAt?.toISOString() ?? null,
      participantCount: row._count.participants,
      extractionCount: row._count.extractions,
    })),
    input.limit,
  )
  return { schemaVersion: 'account-meetings.v1', organization, ...result }
}

export async function getAccountMeeting(
  rawInput: AccountMeetingGetRequest,
  client: Pick<typeof db, 'companyMeeting'> = db,
) {
  const input = AccountMeetingGetRequest.parse(rawInput)
  const meeting = await client.companyMeeting.findFirst({
    where: {
      id: input.meetingId,
      tenantId: input.clientId,
      ...(input.venueId ? { venueId: input.venueId } : {}),
      organization: {
        customerRelationships: { some: { tenantId: input.clientId, status: 'ACTIVE' } },
      },
    },
    select: {
      id: true,
      organizationId: true,
      venueId: true,
      opportunityId: true,
      title: true,
      meetingType: true,
      startedAt: true,
      endedAt: true,
      summary: true,
      transcriptStatus: true,
      processingStatus: true,
      sourceArtifactRef: true,
      processingProvenance: true,
      processedAt: true,
      participants: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, contactId: true, displayName: true, role: true, isTorchiko: true },
      },
      extractions: {
        orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
        take: 100,
        select: {
          id: true,
          type: true,
          content: true,
          structuredData: true,
          confidence: true,
          promotionStatus: true,
          knowledgeItemId: true,
          sourceStartOffset: true,
          sourceEndOffset: true,
          createdByType: true,
          createdById: true,
          modelProvider: true,
          modelName: true,
          createdAt: true,
        },
      },
    },
  })
  if (!meeting) throw new AccountHistoryError('NOT_FOUND', 'Meeting not found in verified scope')
  return {
    schemaVersion: 'account-meeting.v1',
    meeting: {
      ...meeting,
      startedAt: meeting.startedAt.toISOString(),
      endedAt: meeting.endedAt?.toISOString() ?? null,
      processedAt: meeting.processedAt?.toISOString() ?? null,
      extractions: meeting.extractions.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
    },
  }
}

export async function listAccountCorrespondence(
  rawInput: AccountHistoryRequest,
  client: Pick<typeof db, 'prospectOrganization' | 'prospectEmailMessage'> = db,
) {
  const input = AccountHistoryRequest.parse(rawInput)
  const organization = await resolveOrganization(input, client)
  const before = input.before ? new Date(input.before) : undefined
  const rows = await client.prospectEmailMessage.findMany({
    where: { organizationId: organization.id, ...(before ? { occurredAt: { lt: before } } : {}) },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    select: {
      id: true,
      threadId: true,
      contactId: true,
      direction: true,
      status: true,
      fromAddress: true,
      toAddresses: true,
      subject: true,
      textBody: true,
      attachmentMetadata: true,
      occurredAt: true,
      providerAccountId: true,
      providerMessageId: true,
      internetMessageId: true,
      providerAccount: { select: { provider: true, mailboxAddress: true } },
    },
  })
  const result = page(
    rows.map((row) => {
      const gmail = row.providerAccount?.provider === 'GMAIL' ? row.providerAccount : null
      return {
        id: row.id,
        threadId: row.threadId,
        contactId: row.contactId,
        direction: row.direction,
        status: row.status,
        fromAddress: row.fromAddress,
        toAddresses: row.toAddresses,
        subject: row.subject,
        snippet: snippet(row.textBody),
        hasAttachments: Array.isArray(row.attachmentMetadata)
          ? row.attachmentMetadata.length > 0
          : Boolean(row.attachmentMetadata),
        occurredAt: row.occurredAt.toISOString(),
        provenance: {
          sourceType: 'EMAIL',
          sourceId: row.id,
          canonicalAuthority: gmail ? 'GMAIL' : 'TORCHIKO',
          providerAccountId: row.providerAccountId,
          providerMessageId: row.providerMessageId,
          internetMessageId: row.internetMessageId,
          originalSourceUrl:
            gmail && row.internetMessageId
              ? gmailSourceLink(gmail.mailboxAddress, row.internetMessageId)
              : null,
        },
      }
    }),
    input.limit,
  )
  return { schemaVersion: 'account-correspondence.v1', organization, ...result }
}
