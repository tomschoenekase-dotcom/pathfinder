/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    intake: { getProposalReview: { query } },
    admin: { getIntakeProposalReview: { query: vi.fn() } },
  }),
}))
import { IntakeProposalReview } from './IntakeProposalReview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('privacy-safe interview review', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows public text, safe withheld status, discrepancies and timeline without private text', async () => {
    query.mockResolvedValue({
      id: 'run-1',
      role: 'OPERATIONS',
      consentVerified: true,
      summary: { evidenceCount: 2, discrepancyCount: 1 },
      structuredSummary: { handoffReady: false },
      answers: [
        {
          questionId: 'operations.hours',
          prompt: 'What are the hours?',
          fieldPath: 'venue.operations.hours',
          privacy: 'PUBLIC_CANDIDATE',
          confidence: 0.8,
          publicText: 'Open daily.',
          skipped: false,
          redacted: false,
          hasEvidence: true,
          discrepancies: [],
        },
        {
          questionId: 'operations.internal-procedures',
          prompt: 'Internal procedure?',
          fieldPath: 'internal.operationalProcedures',
          privacy: 'PRIVATE',
          confidence: 0.5,
          publicText: null,
          skipped: false,
          redacted: false,
          hasEvidence: true,
          discrepancies: ['LOW_CONFIDENCE'],
        },
      ],
      timeline: [{ id: 'event-1', kind: 'PROPOSAL_CREATED', createdAt: new Date() }],
    })
    render(<IntakeProposalReview venueId="venue-a" runId="run-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Review interview evidence' }))
    expect(await screen.findByText('Open daily.')).toBeTruthy()
    expect(screen.getByText(/Text withheld; evidence hash retained/)).toBeTruthy()
    expect(screen.getByText(/low confidence/)).toBeTruthy()
    expect(screen.getByText(/PROPOSAL CREATED/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('private raw answer')
    expect(document.querySelector('audio')).toBeNull()
    expect(document.querySelector('video')).toBeNull()
    expect(screen.queryByRole('button', { name: /approve|apply|publish/i })).toBeNull()
  })
})
