/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentTaskComposer } from './AgentTaskComposer'

const mutate = vi.fn()
const refresh = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { createAgentTask: { mutate } } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('AgentTaskComposer', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('queues exact scoped intent and never claims that execution started', async () => {
    mutate.mockResolvedValue({
      run: { id: 'run-1' },
      replayed: false,
      executionTriggered: false,
    })
    render(
      <AgentTaskComposer
        tenantId="tenant-1"
        venueId="venue-1"
        identities={[{ id: 'agent-1', name: 'Researcher', enabled: true, agentType: 'CONTENT' }]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Goal'), {
      target: { value: 'Research the venue and prepare a reviewable plan.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Queue task' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    expect(mutate).toHaveBeenCalledWith({
      operationId: expect.any(String),
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      prompt: 'Research the venue and prepare a reviewable plan.',
    })
    expect(await screen.findByText(/connected worker is required/i)).toBeTruthy()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('reports durable dispatch without claiming that the model already completed work', async () => {
    mutate.mockResolvedValue({
      run: { id: 'run-2' },
      replayed: false,
      executionTriggered: true,
    })
    render(
      <AgentTaskComposer
        tenantId="tenant-1"
        venueId="venue-1"
        identities={[{ id: 'agent-1', name: 'EDITH', enabled: true, agentType: 'PRIMARY' }]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Coordinate the team.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Queue task' }))
    expect(await screen.findByText(/queued and dispatched/i)).toBeTruthy()
    expect(screen.queryByText(/completed|finished/i)).toBeNull()
  })

  it('defaults to the primary agent even when a specialist is returned first', () => {
    render(
      <AgentTaskComposer
        tenantId="tenant-1"
        venueId="venue-1"
        identities={[
          { id: 'specialist-1', name: 'Scout', enabled: true, agentType: 'CONTENT' },
          { id: 'primary-1', name: 'EDITH', enabled: true, agentType: 'PRIMARY' },
        ]}
      />,
    )
    expect((screen.getByLabelText('Specialist') as HTMLSelectElement).value).toBe('primary-1')
    expect(screen.getByText(/start with EDITH for coordination/i)).toBeTruthy()
  })
})
