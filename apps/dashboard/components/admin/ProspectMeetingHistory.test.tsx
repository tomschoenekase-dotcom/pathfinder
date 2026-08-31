/* @vitest-environment jsdom */
import React from 'react'
import axe from 'axe-core'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ProspectMeetingHistory, type ProspectMeeting } from './ProspectMeetingHistory'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(cleanup)

const meeting: ProspectMeeting = {
  id: 'meeting-1',
  title: 'Lakeside planning call',
  meetingType: 'GOOGLE_CALENDAR:DEFAULT',
  startedAt: '2026-08-22T15:00:00Z',
  processingStatus: 'PROCESSED',
  transcriptStatus: 'AVAILABLE',
  summary: 'The team reviewed visitor hours and onboarding.',
  sourceArtifactRef: 'https://calendar.google.com/calendar/event?eid=event_1',
  extractions: [{ id: 'extraction-1', type: 'DECISION', content: 'Publish the fall hours.' }],
  transcriptArtifacts: [
    {
      id: 'artifact-1',
      sourceReference: 'https://meet.googleapis.com/v2/conferenceRecords/one/transcripts/two',
      acquiredAt: '2026-08-22T16:00:00Z',
      expiresAt: '2027-08-22T16:00:00Z',
    },
  ],
}

describe('ProspectMeetingHistory', () => {
  it('renders compact knowledge, retention, and a trusted source link', () => {
    render(<ProspectMeetingHistory meetings={[meeting]} />)
    expect(screen.getByText(meeting.summary!)).toBeTruthy()
    expect(screen.getByText(/Transcript metadata retained through/u)).toBeTruthy()
    expect(
      screen
        .getByRole('link', { name: /Open meeting source in Google Calendar/u })
        .getAttribute('href'),
    ).toBe('https://calendar.google.com/calendar/event?eid=event_1')
  })

  it('labels API-only transcript provenance without creating a broken link', () => {
    render(
      <ProspectMeetingHistory
        meetings={[
          { ...meeting, sourceArtifactRef: meeting.transcriptArtifacts[0]!.sourceReference },
        ]}
      />,
    )
    expect(screen.queryByRole('link', { name: /Open meeting source/u })).toBeNull()
    expect(screen.getByText(/API-only reference/u)).toBeTruthy()
  })

  it('has no detectable accessibility violations', async () => {
    const { container } = render(<ProspectMeetingHistory meetings={[meeting]} />)
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
