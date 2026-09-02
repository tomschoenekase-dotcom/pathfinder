/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { guestChatIncidentEvidence: { query } } }),
}))

import { GuestChatIncidentEvidence } from './GuestChatIncidentEvidence'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('GuestChatIncidentEvidence', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('loads a privacy-safe read-only incident explanation on demand', async () => {
    query.mockResolvedValue({
      schemaVersion: 1,
      effect: 'READ_ONLY',
      event: {
        id: 'event_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        occurrenceCount: 2,
        lastOccurredAt: new Date(),
        latestTurn: {
          id: 'turn_1',
          status: 'COMPLETE',
          fallbackCode: 'provider-error',
          completedAt: new Date(),
          providerOperations: [
            {
              kind: 'RESPONSE_GENERATION',
              status: 'OBSERVED',
              outcomeCode: 'FAILED_FALLBACK',
              dispatchedAt: new Date(),
              observedAt: new Date(),
              usage: {
                id: 'usage_1',
                capability: 'STANDARD',
                routeModelKey: 'guest-chat',
                fallbackUsed: false,
                provider: 'anthropic',
                model: 'claude-test',
                latencyMs: 812,
                attempts: 1,
                success: false,
                errorCode: 'provider-error',
                createdAt: new Date(),
              },
            },
          ],
        },
      },
      boundaries: {
        latestOccurrenceOnly: true,
        transcriptIncluded: false,
        promptIncluded: false,
        responseIncluded: false,
        providerExceptionIncluded: false,
        providerControlAuthorized: false,
        retryAuthorized: false,
        incidentMutationAuthorized: false,
      },
    })

    render(<GuestChatIncidentEvidence eventId="event_1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect latest degraded turn' }))

    await waitFor(() =>
      expect(query).toHaveBeenCalledWith(
        { eventId: 'event_1' },
        { signal: expect.any(AbortSignal) },
      ),
    )
    expect(screen.getByText(/exact evidence for the latest turn/i)).toBeTruthy()
    expect(screen.getByText(/anthropic \/ claude-test/i)).toBeTruthy()
    expect(screen.getByText(/transcripts, prompts, responses/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /retry|disable|resolve/i })).toBeNull()
  })

  it('aborts a pending incident read when its alert unmounts', async () => {
    let signal: AbortSignal | undefined
    query.mockImplementation((_input, options) => {
      signal = options.signal
      return new Promise(() => {})
    })
    const view = render(<GuestChatIncidentEvidence eventId="event_1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect latest degraded turn' }))
    await waitFor(() => expect(signal).toBeDefined())
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('contains stalled or provider failures behind fixed recovery guidance', async () => {
    vi.useFakeTimers()
    query.mockImplementation(() => new Promise(() => {}))
    render(<GuestChatIncidentEvidence eventId="event_1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect latest degraded turn' }))
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded in time/i)
    expect(screen.queryByText(/secret provider detail/i)).toBeNull()
  })
})
