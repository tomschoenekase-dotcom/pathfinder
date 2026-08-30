import {
  GoogleCalendarSourceError,
  type GoogleCalendarApiClient,
  type GoogleCalendarApiEvent,
} from './calendar-source'
import type {
  GoogleMeetApiClient,
  GoogleMeetTranscript,
  GoogleMeetTranscriptEntry,
} from './meet-transcript-source'

type Fetch = typeof fetch

async function googleJson<T>(transport: Fetch, url: URL, accessToken: string): Promise<T> {
  const response = await transport(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2_000)
    if (response.status === 401 || response.status === 403) {
      throw new GoogleCalendarSourceError(
        'AUTHENTICATION_REQUIRED',
        detail || 'Google access denied',
      )
    }
    if (response.status === 410) {
      throw new GoogleCalendarSourceError(
        'SYNC_TOKEN_EXPIRED',
        detail || 'Google sync token expired',
      )
    }
    if (response.status === 429 || response.status >= 500) {
      throw new GoogleCalendarSourceError('TRANSIENT', detail || 'Google source unavailable')
    }
    throw new GoogleCalendarSourceError('PERMANENT', detail || 'Google source request failed')
  }
  return (await response.json()) as T
}

export function createGoogleCalendarApiClient(
  input: { fetch?: Fetch } = {},
): GoogleCalendarApiClient {
  const transport = input.fetch ?? fetch
  return {
    async listEvents(request) {
      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
          request.calendarId,
        )}/events`,
      )
      url.searchParams.set('showDeleted', 'true')
      url.searchParams.set('singleEvents', 'true')
      url.searchParams.set('maxResults', '2500')
      if (request.pageToken) url.searchParams.set('pageToken', request.pageToken)
      if (request.syncToken) url.searchParams.set('syncToken', request.syncToken)
      if (request.timeMin) url.searchParams.set('timeMin', request.timeMin)
      if (request.timeMax) url.searchParams.set('timeMax', request.timeMax)
      const payload = await googleJson<{
        items?: GoogleCalendarApiEvent[]
        nextPageToken?: string
        nextSyncToken?: string
      }>(transport, url, request.accessToken)
      return {
        events: payload.items ?? [],
        ...(payload.nextPageToken ? { nextPageToken: payload.nextPageToken } : {}),
        ...(payload.nextSyncToken ? { nextSyncToken: payload.nextSyncToken } : {}),
      }
    },
  }
}

export function createGoogleMeetApiClient(input: { fetch?: Fetch } = {}): GoogleMeetApiClient {
  const transport = input.fetch ?? fetch
  return {
    async listTranscripts(request) {
      const url = new URL(
        `https://meet.googleapis.com/v2/${request.conferenceRecordName}/transcripts`,
      )
      url.searchParams.set('pageSize', '100')
      if (request.pageToken) url.searchParams.set('pageToken', request.pageToken)
      const payload = await googleJson<{
        transcripts?: GoogleMeetTranscript[]
        nextPageToken?: string
      }>(transport, url, request.accessToken)
      return {
        transcripts: payload.transcripts ?? [],
        ...(payload.nextPageToken ? { nextPageToken: payload.nextPageToken } : {}),
      }
    },
    async listTranscriptEntries(request) {
      const url = new URL(`https://meet.googleapis.com/v2/${request.transcriptName}/entries`)
      url.searchParams.set('pageSize', '100')
      if (request.pageToken) url.searchParams.set('pageToken', request.pageToken)
      const payload = await googleJson<{
        transcriptEntries?: GoogleMeetTranscriptEntry[]
        nextPageToken?: string
      }>(transport, url, request.accessToken)
      return {
        entries: payload.transcriptEntries ?? [],
        ...(payload.nextPageToken ? { nextPageToken: payload.nextPageToken } : {}),
      }
    },
  }
}
