import { describe, expect, it, vi } from 'vitest'

import { GoogleCalendarSourceError } from './calendar-source'
import {
  createGoogleCalendarApiClient,
  createGoogleMeetApiClient,
} from './google-workspace-http-client'

describe('Google Workspace source HTTP clients', () => {
  it('requests a bounded Calendar page with deletion and recurring-instance semantics', async () => {
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input
      void init
      return new Response(JSON.stringify({ items: [{ id: 'event_1' }], nextSyncToken: 'sync_2' }))
    })
    const client = createGoogleCalendarApiClient({ fetch: transport })
    await client.listEvents({
      accessToken: 'short-lived',
      calendarId: 'owner@torchiko.com',
      timeMin: '2025-08-22T00:00:00.000Z',
      timeMax: '2027-02-18T00:00:00.000Z',
      showDeleted: true,
      singleEvents: true,
    })
    const url = new URL(String(transport.mock.calls[0]![0]))
    expect(url.pathname).toContain('owner%40torchiko.com/events')
    expect(url.searchParams.get('showDeleted')).toBe('true')
    expect(url.searchParams.get('singleEvents')).toBe('true')
    expect(transport.mock.calls[0]![1]?.headers).toEqual(
      expect.objectContaining({ authorization: 'Bearer short-lived' }),
    )
  })

  it('maps Calendar 410 responses to a recoverable stale-token error', async () => {
    const client = createGoogleCalendarApiClient({
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        void input
        void init
        return new Response('Sync token is no longer valid', { status: 410 })
      }),
    })
    await expect(
      client.listEvents({
        accessToken: 'short-lived',
        calendarId: 'primary',
        syncToken: 'stale',
        showDeleted: true,
        singleEvents: true,
      }),
    ).rejects.toMatchObject({
      code: 'SYNC_TOKEN_EXPIRED',
    } satisfies Partial<GoogleCalendarSourceError>)
  })

  it('exposes transcript endpoints but no recording endpoint', async () => {
    const transport = vi
      .fn(async (input: string | URL | Request, init?: RequestInit) => {
        void input
        void init
        return new Response()
      })
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transcripts: [{ name: 'conferenceRecords/r1/transcripts/t1' }],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ transcriptEntries: [] })))
    const client = createGoogleMeetApiClient({ fetch: transport })
    await client.listTranscripts({
      accessToken: 'short-lived',
      conferenceRecordName: 'conferenceRecords/r1',
    })
    await client.listTranscriptEntries({
      accessToken: 'short-lived',
      transcriptName: 'conferenceRecords/r1/transcripts/t1',
    })
    expect(String(transport.mock.calls[0]![0])).toContain('/conferenceRecords/r1/transcripts')
    expect(String(transport.mock.calls[1]![0])).toContain('/transcripts/t1/entries')
    expect(client).not.toHaveProperty('listRecordings')
  })
})
