/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: { setEvaluationRuntimeDurableGates: { mutate: mocks.mutate } },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { EvaluationRuntimeGateControl } from './EvaluationRuntimeGateControl'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('EvaluationRuntimeGateControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutate.mockResolvedValue({ executionEnabled: false })
  })
  afterEach(cleanup)

  it('shows all three independent gates and requires the exact enable phrase', async () => {
    render(
      <EvaluationRuntimeGateControl
        tenantId="tenant_1"
        venueId="venue_1"
        readiness={{
          apiProcessEnabled: false,
          durableGlobalEnabled: false,
          tenantEnabled: false,
        }}
      />,
    )
    expect(screen.getByText('Railway API process')).toBeTruthy()
    expect(screen.getByText('Durable global intent')).toBeTruthy()
    expect(screen.getByText('This tenant')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Enable durable gates' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Type ENABLE EVALUATION RUNNER'), {
      target: { value: 'ENABLE EVALUATION RUNNER' },
    })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        enabled: true,
        expectedGlobalEnabled: false,
        expectedTenantEnabled: false,
        confirmation: 'ENABLE EVALUATION RUNNER',
      }),
    )
    expect(screen.getByText(/Railway process gate remains off/)).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('permits an immediate durable shutdown with current-state compare-and-set values', async () => {
    mocks.mutate.mockResolvedValue({ executionEnabled: false })
    render(
      <EvaluationRuntimeGateControl
        tenantId="tenant_1"
        venueId="venue_1"
        readiness={{ apiProcessEnabled: true, durableGlobalEnabled: true, tenantEnabled: true }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Disable durable gates' }))
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        enabled: false,
        expectedGlobalEnabled: true,
        expectedTenantEnabled: true,
      }),
    )
    expect(screen.getByText(/New evaluation execution is closed/)).toBeTruthy()
  })
})
