import { describe, expect, it, vi } from 'vitest'

import {
  getAccountMeeting,
  getAccountTimeline,
  listAccountCorrespondence,
  listAccountMeetings,
} from './account-history'

function database() {
  return {
    prospectOrganization: {
      findFirst: vi.fn().mockResolvedValue({ id: 'org_1', canonicalName: 'Museum Y' }),
    },
    prospectActivity: { findMany: vi.fn().mockResolvedValue([]) },
    prospectEmailMessage: { findMany: vi.fn().mockResolvedValue([]) },
    companyMeeting: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
    accountMilestone: { findMany: vi.fn().mockResolvedValue([]) },
    supportRequest: { findMany: vi.fn().mockResolvedValue([]) },
  }
}

describe('bounded account history projections', () => {
  it('resolves tenant authority before querying and merges bounded timeline records', async () => {
    const client = database()
    client.prospectActivity.findMany.mockResolvedValue([
      {
        id: 'activity_1',
        type: 'NOTE',
        summary: 'Follow-up planned',
        detail: null,
        occurredAt: new Date('2030-01-04T00:00:00.000Z'),
      },
    ])
    client.companyMeeting.findMany.mockResolvedValue([
      {
        id: 'meeting_1',
        title: 'Review',
        meetingType: 'CLIENT_REVIEW',
        summary: 'Agreed next launch step.',
        startedAt: new Date('2030-01-03T00:00:00.000Z'),
      },
    ])
    const result = await getAccountTimeline(
      { clientId: 'tenant_1', organizationId: 'org_1', venueId: 'venue_1', limit: 10 },
      client as never,
    )
    expect(client.prospectOrganization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'org_1',
          customerRelationships: { some: { tenantId: 'tenant_1', status: 'ACTIVE' } },
        }),
      }),
    )
    expect(client.companyMeeting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant_1', venueId: 'venue_1' }),
        take: 11,
      }),
    )
    expect(result.items.map((item) => item.kind)).toEqual(['CRM_ACTIVITY', 'MEETING'])
  })

  it('returns meeting list summaries without source artifacts and exact detail only in get', async () => {
    const client = database()
    client.companyMeeting.findMany.mockResolvedValue([
      {
        id: 'meeting_1',
        title: 'Review',
        meetingType: 'CLIENT_REVIEW',
        startedAt: new Date('2030-01-03T00:00:00.000Z'),
        endedAt: null,
        summary: 'Summary',
        transcriptStatus: 'RETAINED_EXTERNALLY',
        processingStatus: 'COMPLETE',
        processedAt: new Date('2030-01-03T01:00:00.000Z'),
        _count: { participants: 2, extractions: 3 },
      },
    ])
    const listed = await listAccountMeetings(
      { clientId: 'tenant_1', organizationId: 'org_1' },
      client as never,
    )
    expect(listed.items[0]).not.toHaveProperty('sourceArtifactRef')

    client.companyMeeting.findFirst.mockResolvedValue({
      id: 'meeting_1',
      organizationId: 'org_1',
      venueId: 'venue_1',
      opportunityId: null,
      title: 'Review',
      meetingType: 'CLIENT_REVIEW',
      startedAt: new Date('2030-01-03T00:00:00.000Z'),
      endedAt: null,
      summary: 'Summary',
      transcriptStatus: 'RETAINED_EXTERNALLY',
      processingStatus: 'COMPLETE',
      sourceArtifactRef: 'drive://transcript_1',
      processingProvenance: {},
      processedAt: new Date('2030-01-03T01:00:00.000Z'),
      participants: [],
      extractions: [],
    })
    const detail = await getAccountMeeting(
      { clientId: 'tenant_1', venueId: 'venue_1', meetingId: 'meeting_1' },
      client as never,
    )
    expect(detail.meeting.sourceArtifactRef).toBe('drive://transcript_1')
    expect(client.companyMeeting.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'meeting_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
        }),
      }),
    )
  })

  it('returns only compact plain-text correspondence snippets', async () => {
    const client = database()
    client.prospectEmailMessage.findMany.mockResolvedValue([
      {
        id: 'message_1',
        threadId: 'thread_1',
        contactId: 'contact_1',
        direction: 'INBOUND',
        status: 'RECEIVED',
        fromAddress: 'jane@example.com',
        toAddresses: ['team@torchiko.com'],
        subject: 'Updated map',
        bodyPreview: `Here is the map. ${'x'.repeat(500)}`,
        attachmentMetadata: [{ name: 'map.pdf' }],
        occurredAt: new Date('2030-01-03T00:00:00.000Z'),
        providerAccountId: 'gmail_account_1',
        providerMessageId: 'gmail_message_1',
        internetMessageId: '<message-1@example.com>',
        sourceReference: null,
        providerAccount: { provider: 'GMAIL', mailboxAddress: 'team@torchiko.com' },
      },
    ])
    const result = await listAccountCorrespondence(
      { clientId: 'tenant_1', organizationId: 'org_1' },
      client as never,
    )
    expect(result.items[0]?.snippet?.length).toBeLessThanOrEqual(320)
    expect(result.items[0]?.hasAttachments).toBe(true)
    expect(result.items[0]).not.toHaveProperty('textBody')
    expect(result.items[0]?.provenance).toEqual(
      expect.objectContaining({
        canonicalAuthority: 'GMAIL',
        providerAccountId: 'gmail_account_1',
        providerMessageId: 'gmail_message_1',
        originalSourceUrl:
          'https://mail.google.com/mail/u/team%40torchiko.com/#search/rfc822msgid%3A%3Cmessage-1%40example.com%3E',
      }),
    )
  })

  it('does not query history when the active tenant relationship cannot be resolved', async () => {
    const client = database()
    client.prospectOrganization.findFirst.mockResolvedValue(null)
    await expect(
      getAccountTimeline({ clientId: 'tenant_1', organizationId: 'foreign_org' }, client as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(client.prospectActivity.findMany).not.toHaveBeenCalled()
  })
})
