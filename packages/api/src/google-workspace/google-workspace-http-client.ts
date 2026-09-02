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
const GOOGLE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024
const GOOGLE_REQUEST_TIMEOUT_MS = 30_000

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > GOOGLE_RESPONSE_MAX_BYTES)) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error('response-too-large')
  }
  if (!response.body) throw new Error('malformed-response')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let reading = true
  try {
    while (reading) {
      const { done, value } = await reader.read()
      if (done) {
        reading = false
        continue
      }
      totalBytes += value.byteLength
      if (totalBytes > GOOGLE_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined)
        throw new Error('response-too-large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

async function googleJson<T>(
  transport: Fetch,
  url: URL,
  accessToken: string,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try {
      response = await transport(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: controller.signal,
      })
    } catch {
      throw new GoogleCalendarSourceError(
        'TRANSIENT',
        controller.signal.aborted ? 'Google source request timed out' : 'Google source unavailable',
      )
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      if (response.status === 401 || response.status === 403) {
        throw new GoogleCalendarSourceError('AUTHENTICATION_REQUIRED', 'Google access denied')
      }
      if (response.status === 410) {
        throw new GoogleCalendarSourceError('SYNC_TOKEN_EXPIRED', 'Google sync token expired')
      }
      if (response.status === 429 || response.status >= 500) {
        throw new GoogleCalendarSourceError('TRANSIENT', 'Google source unavailable')
      }
      throw new GoogleCalendarSourceError('PERMANENT', 'Google source request failed')
    }
    try {
      return (await readBoundedJson(response)) as T
    } catch {
      if (controller.signal.aborted) {
        throw new GoogleCalendarSourceError('TRANSIENT', 'Google source request timed out')
      }
      throw new GoogleCalendarSourceError('PERMANENT', 'Google returned a malformed response')
    }
  } finally {
    clearTimeout(timeout)
  }
}

function boundedTimeout(value: number | undefined) {
  const timeoutMs = value ?? GOOGLE_REQUEST_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Google request timeout must be an integer from 1 to 60000 milliseconds')
  }
  return timeoutMs
}

export function createGoogleCalendarApiClient(
  input: { fetch?: Fetch; requestTimeoutMs?: number } = {},
): GoogleCalendarApiClient {
  const transport = input.fetch ?? fetch
  const timeoutMs = boundedTimeout(input.requestTimeoutMs)
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
      }>(transport, url, request.accessToken, timeoutMs)
      return {
        events: payload.items ?? [],
        ...(payload.nextPageToken ? { nextPageToken: payload.nextPageToken } : {}),
        ...(payload.nextSyncToken ? { nextSyncToken: payload.nextSyncToken } : {}),
      }
    },
  }
}

export function createGoogleMeetApiClient(
  input: { fetch?: Fetch; requestTimeoutMs?: number } = {},
): GoogleMeetApiClient {
  const transport = input.fetch ?? fetch
  const timeoutMs = boundedTimeout(input.requestTimeoutMs)
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
      }>(transport, url, request.accessToken, timeoutMs)
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
      }>(transport, url, request.accessToken, timeoutMs)
      return {
        entries: payload.transcriptEntries ?? [],
        ...(payload.nextPageToken ? { nextPageToken: payload.nextPageToken } : {}),
      }
    },
  }
}
