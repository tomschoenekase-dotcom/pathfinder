/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WeeklyReportLifecycleEvidence } from './WeeklyReportLifecycleEvidence'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(cleanup)
describe('WeeklyReportLifecycleEvidence', () => {
  it('shows an honest evidence-loading failure without an action', () => {
    render(<WeeklyReportLifecycleEvidence evidence={null} />)
    expect(screen.getByText(/evidence unavailable/i)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('shows simple status, dark state and bounded evidence without raw payloads', () => {
    render(
      <WeeklyReportLifecycleEvidence
        evidence={{
          scope: { tenantId: 't1', venueId: 'v1', reportId: 'r1' },
          version: 'v1',
          status: 'QUEUED',
          legacyStatus: 'GENERATING',
          executionEnabled: false,
          report: {
            generatedAt: null,
            publishedAt: null,
            answerCount: 0,
            sessionCount: 0,
            error: null,
          },
          dispatch: {
            id: 'd1',
            status: 'PENDING',
            attempts: 0,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          jobs: [],
          audits: [],
        }}
      />,
    )
    expect(screen.getByText('QUEUED')).toBeTruthy()
    expect(screen.getByText('Dark / default-off')).toBeTruthy()
    expect(screen.getByText(/raw job payloads/i)).toBeTruthy()
  })
})
