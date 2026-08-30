import { describe, expect, it } from 'vitest'

import {
  buildGmailBodyRetentionDryRun,
  GoogleCalendarEventProjection,
  GoogleMeetTranscriptArtifact,
} from './google-workspace-source'

describe('Google Workspace source contracts', () => {
  it('accepts a provenance-only recurring Calendar projection', () => {
    expect(
      GoogleCalendarEventProjection.parse({
        providerAccountId: 'acct_1',
        calendarId: 'primary',
        externalEventId: 'event_instance_1',
        iCalUid: 'series@example.com',
        recurringEventId: 'series_1',
        originalStartAt: '2026-08-22T15:00:00.000Z',
        title: 'Customer check-in',
        eventType: 'default',
        status: 'CONFIRMED',
        startAt: '2026-08-22T15:30:00.000Z',
        endAt: '2026-08-22T16:00:00.000Z',
        timeZone: 'America/Chicago',
        organizerEmail: 'owner@torchiko.com',
        attendees: [],
        sourceReference: 'https://calendar.google.com/calendar/event?eid=event_instance_1',
        providerUpdatedAt: '2026-08-22T14:00:00.000Z',
        sequence: 2,
      }).recurringEventId,
    ).toBe('series_1')
  })

  it('enforces exactly one year of transcript retention and has no recording field', () => {
    const artifact = GoogleMeetTranscriptArtifact.parse({
      conferenceRecordName: 'conferenceRecords/conference_1',
      transcriptName: 'conferenceRecords/conference_1/transcripts/transcript_1',
      sourceReference:
        'https://meet.googleapis.com/v2/conferenceRecords/conference_1/transcripts/transcript_1',
      entries: [],
      acquiredAt: '2026-08-22T00:00:00.000Z',
      expiresAt: '2027-08-22T00:00:00.000Z',
    })
    expect(Object.hasOwn(artifact, 'recording')).toBe(false)
    expect(() =>
      GoogleMeetTranscriptArtifact.parse({
        ...artifact,
        expiresAt: '2027-08-23T00:00:00.000Z',
      }),
    ).toThrow(/exactly 365 days/)
  })

  it('classifies body retention without authorizing deletion', () => {
    expect(
      buildGmailBodyRetentionDryRun(
        [
          {
            id: 'expired',
            state: 'TEMPORARY',
            hasTextBody: true,
            hasHtmlBody: false,
            expiresAt: new Date('2026-08-21T00:00:00.000Z'),
          },
          {
            id: 'source-only',
            state: 'NOT_STORED',
            hasTextBody: false,
            hasHtmlBody: false,
            expiresAt: null,
          },
          {
            id: 'legacy',
            state: 'LEGACY_REVIEW_REQUIRED',
            hasTextBody: true,
            hasHtmlBody: true,
            expiresAt: null,
          },
        ],
        new Date('2026-08-22T00:00:00.000Z'),
      ),
    ).toMatchObject({
      scanned: 3,
      sourceOnly: 1,
      eligibleForRemoval: 1,
      legacyReviewRequired: 1,
    })
  })
})
