/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentRoutinesView } from './AgentRoutinesView'

const mutate = vi.fn()
const refresh = vi.fn()

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      createAgentRoutine: { mutate },
      setAgentRoutineEnabled: { mutate },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const identity = {
  id: 'identity-1',
  name: 'Reliability Evaluator',
  agentType: 'EVALUATION',
  enabled: true,
}
const routine = {
  id: 'routine-1',
  routineKey: 'venue.freshness',
  agentIdentityId: identity.id,
  requestedOperation: 'routine_monitor',
  intervalSeconds: 3600,
  maxAttempts: 1,
  maxRunsPerDay: 24,
  perRunBudgetE8Usd: '1',
  dailyBudgetE8Usd: '100000000',
  requiredWorkerRoles: ['read-only-monitor'],
  requiredWorkerCapabilities: ['content.read'],
  enabled: false,
  nextRunAt: null,
  lastRunAt: null,
  lastAgentRunId: null,
  lastSkipReason: 'DISABLED',
  createdAt: new Date('2026-09-18T10:00:00Z'),
  updatedAt: new Date('2026-09-18T10:00:00Z'),
  agentIdentity: { id: identity.id, name: identity.name, enabled: true },
}

describe('AgentRoutinesView', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('creates a disabled definition with the bounded monitoring fields', async () => {
    mutate.mockResolvedValue({ routine: { id: 'routine-2' }, replayed: false })
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111',
    )
    render(
      <AgentRoutinesView
        tenantId="tenant-1"
        venueId="venue-1"
        routines={[]}
        identities={[identity]}
      />,
    )

    fireEvent.click(screen.getByText(/Add monitoring definition/i))
    fireEvent.change(screen.getByLabelText('Routine key'), { target: { value: 'venue.freshness' } })
    fireEvent.change(screen.getByLabelText('Read-only monitoring prompt'), {
      target: { value: 'Inspect approved evidence only.' },
    })
    expect(screen.queryByRole('spinbutton', { name: 'Maximum attempts / run' })).toBeNull()
    expect(document.body.textContent).toContain('1 (fixed; retries are not enabled)')
    expect(document.body.textContent).toContain(
      'USD budget enforcement: not supported in this subset; use max runs/day and provider-side limits.',
    )
    fireEvent.change(screen.getByLabelText('Required worker roles'), {
      target: { value: 'read-only-monitor, reviewer' },
    })
    fireEvent.change(screen.getByLabelText('Required capabilities'), {
      target: { value: 'content.read' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save disabled definition' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    expect(mutate).toHaveBeenCalledWith({
      operationId: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      routineKey: 'venue.freshness',
      agentIdentityId: 'identity-1',
      prompt: 'Inspect approved evidence only.',
      requestedOperation: 'routine_monitor',
      intervalSeconds: 3600,
      maxAttempts: 1,
      maxRunsPerDay: 24,
      requiredWorkerRoles: ['read-only-monitor', 'reviewer'],
      requiredWorkerCapabilities: ['content.read'],
    })
    const firstCall = mutate.mock.calls[0]
    expect(firstCall).toBeDefined()
    expect(firstCall![0]).not.toHaveProperty('perRunBudgetE8Usd')
    expect(firstCall![0]).not.toHaveProperty('dailyBudgetE8Usd')
    expect(screen.getByText('Definition saved disabled. No run was started.')).toBeTruthy()
  })

  it('labels existing budget-bearing routines as unsupported configuration', () => {
    render(
      <AgentRoutinesView
        tenantId="tenant-1"
        venueId="venue-1"
        routines={[routine]}
        identities={[identity]}
      />,
    )

    expect(document.body.textContent).toContain('USD budgetUnsupported configuration')
  })

  it('requires a second deliberate action before enabling a routine', async () => {
    mutate.mockResolvedValue({
      routine: { ...routine, enabled: true },
      replayed: false,
      executionTriggered: false,
    })
    render(
      <AgentRoutinesView
        tenantId="tenant-1"
        venueId="venue-1"
        routines={[routine]}
        identities={[identity]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Enable routine' }))
    expect(mutate).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        'This only makes the definition eligible for the independently gated scheduler; it does not start a run.',
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm enable' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    expect(mutate).toHaveBeenCalledWith({
      operationId: expect.any(String),
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      routineId: 'routine-1',
      enabled: true,
    })
    expect(
      await screen.findByText(
        'Enabled. The routine is now eligible for the independently gated scheduler; no run was started by this action.',
      ),
    ).toBeTruthy()
  })
})
