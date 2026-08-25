/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { getIntakeBuilderLifecycle: { query } } }),
}))

import { IntakeBuilderLifecyclePanel } from './IntakeBuilderLifecyclePanel'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('IntakeBuilderLifecyclePanel', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders the full evidence-derived lifecycle and its blocker', async () => {
    query.mockResolvedValue({
      schemaVersion: 1,
      runId: 'run-a',
      runStatus: 'AWAITING_REVIEW',
      currentStage: 'RESEARCH',
      currentState: 'BLOCKED',
      nextAction: 'CONFIGURE_RESEARCH_ADAPTER',
      requiresHumanApproval: false,
      autoApprove: false,
      autoApply: false,
      autoPublish: false,
      stages: [
        { stage: 'INGEST', state: 'COMPLETE', evidenceRefs: [], blockers: [] },
        {
          stage: 'RESEARCH',
          state: 'BLOCKED',
          evidenceRefs: [],
          blockers: [
            {
              code: 'RESEARCH_ADAPTER_REQUIRED',
              path: 'sourceKind',
              message: 'No reviewed website research result is linked to this intake run.',
            },
          ],
        },
      ],
    })
    render(<IntakeBuilderLifecyclePanel tenantId="tenant-a" venueId="venue-a" runId="run-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Builder status' }))

    expect(await screen.findByRole('heading', { name: 'Research · blocked' })).toBeTruthy()
    expect(screen.getByText(/No reviewed website research result/)).toBeTruthy()
    expect(query).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    expect(screen.queryByRole('button', { name: /approve|apply|publish/i })).toBeNull()
  })
})
