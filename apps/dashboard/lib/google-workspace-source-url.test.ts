import { describe, expect, it } from 'vitest'

import { safeGoogleWorkspaceSourceUrl } from './google-workspace-source-url'

describe('safeGoogleWorkspaceSourceUrl', () => {
  it.each([
    ['https://calendar.google.com/calendar/event?eid=event_1', 'Calendar'],
    ['https://drive.google.com/file/d/transcript-1/view', 'Drive'],
    ['https://docs.google.com/document/d/transcript-1/edit', 'Drive'],
    ['https://meet.google.com/abc-defg-hij', 'Meet'],
  ])('accepts a trusted browser source %s', (url, kind) => {
    expect(safeGoogleWorkspaceSourceUrl(url)).toEqual({ kind, url })
  })

  it.each([
    null,
    '',
    'drive://transcript-1',
    'javascript:alert(1)',
    'http://calendar.google.com/calendar/event?eid=event_1',
    'https://meet.googleapis.com/v2/conferenceRecords/one/transcripts/two',
    'https://calendar.google.com.evil.example/calendar/event',
    'https://user:password@drive.google.com/file/d/one/view',
    'https://drive.google.com:444/file/d/one/view',
  ])('rejects an unsafe or API-only reference %s', (reference) => {
    expect(safeGoogleWorkspaceSourceUrl(reference)).toBeNull()
  })
})
