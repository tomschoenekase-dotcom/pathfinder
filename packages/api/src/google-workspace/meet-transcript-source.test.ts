import { describe, expect, it, vi } from 'vitest'

import {
  createGoogleMeetTranscriptSource,
  type GoogleMeetTranscriptStore,
} from './meet-transcript-source'

const credentials = {
  lease: vi.fn(async () => ({
    withAccessToken: async <T>(callback: (token: string) => Promise<T>) => callback('short-lived'),
  })),
}

describe('Google Meet transcript source', () => {
  it('records unavailable transcripts honestly', async () => {
    const client = {
      listTranscripts: vi.fn(async () => ({ transcripts: [] })),
      listTranscriptEntries: vi.fn(),
    }
    const store = {
      upsertTranscript: vi.fn(),
      markTranscriptUnavailable: vi.fn(async () => undefined),
    }
    await expect(
      createGoogleMeetTranscriptSource({ credentials, client, store }).acquire({
        providerAccountId: 'account_1',
        credentialReferenceId: 'credential_1',
        meetingId: 'meeting_1',
        conferenceRecordName: 'conferenceRecords/record_1',
      }),
    ).resolves.toEqual({ state: 'UNAVAILABLE', acquired: 0 })
    expect(store.upsertTranscript).not.toHaveBeenCalled()
  })

  it('retains transcript entries for one year and remains idempotency-store compatible', async () => {
    const client = {
      listTranscripts: vi.fn(async () => ({
        transcripts: [{ name: 'conferenceRecords/record_1/transcripts/transcript_1' }],
      })),
      listTranscriptEntries: vi.fn(async () => ({
        entries: [
          {
            name: 'conferenceRecords/record_1/transcripts/transcript_1/entries/entry_1',
            participant: 'conferenceRecords/record_1/participants/person_1',
            text: 'We will follow up next week.',
            languageCode: 'en-US',
            startTime: '2026-08-22T15:00:00Z',
            endTime: '2026-08-22T15:00:04Z',
          },
        ],
      })),
    }
    const store = {
      upsertTranscript: vi.fn(
        async (input: Parameters<GoogleMeetTranscriptStore['upsertTranscript']>[0]) => {
          expect(input.meetingId).toBe('meeting_1')
          return 'UNCHANGED' as const
        },
      ),
      markTranscriptUnavailable: vi.fn(),
    }
    const source = createGoogleMeetTranscriptSource({
      credentials,
      client,
      store,
      now: () => new Date('2026-08-22T00:00:00Z'),
    })
    await source.acquire({
      providerAccountId: 'account_1',
      credentialReferenceId: 'credential_1',
      meetingId: 'meeting_1',
      conferenceRecordName: 'conferenceRecords/record_1',
    })
    const artifact = store.upsertTranscript.mock.calls[0]![0].artifact
    expect(artifact.expiresAt).toBe('2027-08-22T00:00:00.000Z')
    expect(artifact.entries).toHaveLength(1)
    expect(artifact).not.toHaveProperty('recording')
    expect(client).not.toHaveProperty('listRecordings')
  })
})
