import { describe, expect, it, vi } from 'vitest'

import type {
  GoogleCalendarEventProjection,
  GoogleMeetTranscriptArtifact,
} from '@pathfinder/contracts/google-workspace-source'

import { createGoogleWorkspaceSourceStores } from './google-workspace-source-actions'

const actor = {
  type: 'INTEGRATION',
  actorId: 'google-workspace',
  role: 'INTEGRATION',
  integrationId: 'google-workspace',
} as const

function harness() {
  const tx = {
    correspondenceProviderAccount: {
      findFirst: vi.fn().mockResolvedValue({ id: 'account_1' }),
    },
    prospectContact: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'contact_1', normalizedEmail: 'jane@example.com', organizationId: 'org_1' },
        ]),
    },
    companyMeeting: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'meeting_1' }),
      update: vi.fn().mockResolvedValue({ id: 'meeting_1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    companyMeetingParticipant: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    googleCalendarSyncState: { upsert: vi.fn() },
    companyMeetingTranscriptArtifact: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'transcript_artifact_1' }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, client: client as never }
}

const calendarEvent: GoogleCalendarEventProjection = {
  providerAccountId: 'account_1',
  calendarId: 'primary',
  externalEventId: 'event_1',
  iCalUid: 'event_1@example.com',
  recurringEventId: null,
  originalStartAt: null,
  title: 'Customer check-in',
  eventType: 'default',
  status: 'CONFIRMED',
  startAt: '2026-08-22T15:00:00.000Z',
  endAt: '2026-08-22T15:30:00.000Z',
  timeZone: 'America/Chicago',
  organizerEmail: 'owner@torchiko.com',
  attendees: [
    {
      email: 'jane@example.com',
      displayName: 'Jane',
      responseStatus: 'accepted',
      organizer: false,
      self: false,
    },
  ],
  sourceReference: 'https://calendar.google.com/calendar/event?eid=event_1',
  providerUpdatedAt: '2026-08-22T14:00:00.000Z',
  sequence: 1,
}

describe('Google Workspace source persistence', () => {
  it('ingests Calendar relationships idempotently with participant resolution and audit', async () => {
    const { tx, client } = harness()
    const stores = createGoogleWorkspaceSourceStores({ actor }, client)
    await expect(stores.calendar.upsertEvent(calendarEvent)).resolves.toBe('INSERTED')
    expect(tx.companyMeeting.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerAccountId: 'account_1',
          organizationId: 'org_1',
          eventStatus: 'CONFIRMED',
          processingProvenance: expect.objectContaining({
            commitmentInference: 'DISALLOWED_FROM_TITLE',
          }),
        }),
      }),
    )
    expect(tx.companyMeetingParticipant.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ contactId: 'contact_1', email: 'jane@example.com' })],
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorType: 'INTEGRATION' }) }),
    )
  })

  it('preserves cancellation tombstones when Google supplies only an event id', async () => {
    const { tx, client } = harness()
    const stores = createGoogleWorkspaceSourceStores({ actor }, client)
    await expect(
      stores.calendar.applyCancellation({
        providerAccountId: 'account_1',
        calendarId: 'primary',
        externalEventId: 'deleted_1',
        recurringEventId: 'series_1',
        originalStartAt: '2026-08-22T15:00:00.000Z',
        providerUpdatedAt: '2026-08-22T14:00:00.000Z',
      }),
    ).resolves.toBe('CANCELLED')
    expect(tx.companyMeeting.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventStatus: 'CANCELLED', recurringEventId: 'series_1' }),
      }),
    )
  })

  it('stores transcript text with one-year expiry and no recording column', async () => {
    const { tx, client } = harness()
    tx.companyMeeting.findUnique.mockResolvedValue({ id: 'meeting_1', tenantId: null })
    const artifact: GoogleMeetTranscriptArtifact = {
      conferenceRecordName: 'conferenceRecords/record_1',
      transcriptName: 'conferenceRecords/record_1/transcripts/transcript_1',
      sourceReference:
        'https://meet.googleapis.com/v2/conferenceRecords/record_1/transcripts/transcript_1',
      entries: [
        {
          externalEntryId: 'entry_1',
          participantReference: 'participant_1',
          text: 'Follow up next week.',
          languageCode: 'en-US',
          startedAt: '2026-08-22T15:00:00.000Z',
          endedAt: '2026-08-22T15:00:04.000Z',
        },
      ],
      acquiredAt: '2026-08-22T00:00:00.000Z',
      expiresAt: '2027-08-22T00:00:00.000Z',
    }
    const stores = createGoogleWorkspaceSourceStores({ actor }, client)
    await expect(
      stores.meet.upsertTranscript({
        providerAccountId: 'account_1',
        meetingId: 'meeting_1',
        artifact,
      }),
    ).resolves.toBe('INSERTED')
    expect(tx.companyMeetingTranscriptArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          transcriptText: 'Follow up next week.',
          expiresAt: new Date('2027-08-22T00:00:00.000Z'),
        }),
      }),
    )
    expect(
      JSON.stringify(tx.companyMeetingTranscriptArtifact.create.mock.calls[0]![0]),
    ).not.toMatch(/recording/iu)
  })
})
