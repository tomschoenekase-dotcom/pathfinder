/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { visitorFeedbackHazardEvidence: { query } } }),
}))

import { VisitorFeedbackHazardEvidence } from './VisitorFeedbackHazardEvidence'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    effect: 'READ_ONLY',
    event: {
      id: 'event_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      occurrenceCount: 2,
      lastOccurredAt: new Date(),
    },
    currentFeedback: {
      id: 'feedback_1',
      rating: 'NOT_HELPFUL',
      reason: 'There is broken glass by the east entrance.',
      updatedAt: new Date(),
      sessionId: 'session_1',
      linkedMessage: {
        id: 'message_1',
        role: 'assistant',
        content: 'The east entrance is open.',
        createdAt: new Date(),
      },
    },
    boundaries: {
      signalUnverified: true,
      feedbackMutable: true,
      currentFeedbackOnly: true,
      venuePublicationAuthorized: false,
      operationalMutationAuthorized: false,
    },
    ...overrides,
  }
}

describe('VisitorFeedbackHazardEvidence', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows the on-demand loading state then the current mutable unverified record', async () => {
    let resolve: ((value: ReturnType<typeof evidence>) => void) | undefined
    query.mockImplementation(
      () =>
        new Promise<ReturnType<typeof evidence>>((done) => {
          resolve = done
        }),
    )
    render(<VisitorFeedbackHazardEvidence eventId="event_1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect current visitor feedback' }))

    expect(
      (screen.getByRole('button', { name: 'Reading current feedback…' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    await act(async () => resolve!(evidence()))
    await waitFor(() => expect(screen.getByText('Current mutable feedback record')).toBeTruthy())
    expect(screen.getByText(/unverified signal/i)).toBeTruthy()
    expect(screen.getByText('Not helpful')).toBeTruthy()
    expect(screen.getByText('There is broken glass by the east entrance.')).toBeTruthy()
    expect(screen.getByText('The east entrance is open.')).toBeTruthy()
    expect(
      screen.getByRole('link', { name: 'Review linked conversation' }).getAttribute('href'),
    ).toBe('/admin/clients/tenant_1/venues/venue_1/chatlogs/session_1')
    expect(screen.getByText(/does not publish a venue notice/i)).toBeTruthy()
  })

  it('shows current changed feedback and allows retry after unavailable evidence', async () => {
    query.mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce(
      evidence({
        currentFeedback: {
          ...evidence().currentFeedback,
          rating: 'HELPFUL',
          reason: 'The answer is correct.',
        },
      }),
    )
    render(<VisitorFeedbackHazardEvidence eventId="event_1" />)
    const inspect = screen.getByRole('button', { name: 'Inspect current visitor feedback' })
    fireEvent.click(inspect)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/unavailable/i))

    fireEvent.click(inspect)
    await waitFor(() => expect(screen.getByText('Helpful')).toBeTruthy())
    expect(screen.getByText('The answer is correct.')).toBeTruthy()
    expect(query).toHaveBeenCalledTimes(2)
  })
})
