/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.hoisted(() => vi.fn())
const reset = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      saveAiWorkloadConfigurationOverride: { mutate },
      resetAiWorkloadConfigurationOverride: { mutate: reset },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { AiWorkloadConfigurationView } from './AiWorkloadConfigurationView'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const data = {
  readOnly: false,
  stagedControlPlane: true,
  providerExecution: false,
  scope: { tenantId: 'tenant-1', venueId: 'venue-1' },
  layers: [
    { level: 'PLATFORM', availability: 'AVAILABLE', detail: 'Registry active.' },
    { level: 'WORKLOAD', availability: 'AVAILABLE', detail: 'Global workload override.' },
    { level: 'CLIENT', availability: 'AVAILABLE', detail: 'Client override.' },
    { level: 'VENUE', availability: 'AVAILABLE', detail: 'Venue override.' },
  ],
  budgetIntegration: { availability: 'STAGED', detail: 'Runtime gate is separate.' },
  modelOptions: [
    { key: 'guest-chat', kind: 'TEXT', provider: 'anthropic', model: 'configured-model' },
  ],
  workloads: [
    {
      workloadId: 'guest-chat',
      kind: 'TEXT',
      provider: 'anthropic',
      model: 'configured-model',
      effectiveSource: 'PLATFORM',
      fallback: { enabled: false, modelKeys: [] },
      requestBudgetCeilingE8Usd: null,
      unsafeChangesEnabled: false,
      effective: {
        primaryModelKey: 'guest-chat',
        fallback: { enabled: false, modelKeys: [] },
        timeoutMs: 10_000,
        maxAttempts: 2,
        maxOutputTokens: 512,
        requestBudgetCeilingE8Usd: null,
        sources: {
          primaryModelKey: 'PLATFORM',
          fallback: 'PLATFORM',
          timeoutMs: 'PLATFORM',
          maxAttempts: 'PLATFORM',
          maxOutputTokens: 'PLATFORM',
          requestBudgetCeilingE8Usd: 'PLATFORM',
        },
      },
      overrides: { workload: null, client: null, venue: null },
      pricingEstimate: {
        version: 'configured-pricing-v1',
        usdPerMillionTokens: { input: 1, output: 5 },
        invoiceAmount: false,
      },
      limits: {
        timeoutMs: 10_000,
        maxAttempts: 2,
        maxInputUtf8Bytes: 100,
        maxBillableInputTokens: 200,
        maxOutputTokens: 512,
      },
    },
  ],
}

describe('AiWorkloadConfigurationView', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mutate.mockResolvedValue({ id: 'override-1', revision: 1, enabled: false })
  })
  afterEach(cleanup)

  it('shows effective sources, explicit staging, and no secret or provider-execution control', () => {
    const { container } = render(<AiWorkloadConfigurationView data={data as never} />)

    expect(screen.getByRole('heading', { name: 'AI workloads' })).toBeTruthy()
    expect(screen.getByText('anthropic / configured-model')).toBeTruthy()
    expect(screen.getByText('Inherited')).toBeTruthy()
    expect(screen.getAllByText('available')).toHaveLength(4)
    expect(screen.getByText(/never calls a provider/i)).toBeTruthy()
    expect(container.textContent).not.toMatch(/api key|credential|secret/iu)
  })

  it('deliberately saves a default-off venue override with reason and CAS identity', async () => {
    render(<AiWorkloadConfigurationView data={data as never} />)
    fireEvent.click(screen.getByText(/Edit venue override/))
    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: 'Stage reduced retry profile for review' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save staged override' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    expect(mutate).toHaveBeenCalledWith({
      scope: {
        level: 'VENUE',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        workloadId: 'guest-chat',
      },
      expectedRevision: null,
      enabled: false,
      values: {
        fallback: { enabled: false, modelKeys: [] },
        timeoutMs: 10_000,
        maxAttempts: 2,
      },
      unsafeChangesEnabled: false,
      reason: 'Stage reduced retry profile for review',
    })
    expect(await screen.findByText(/Provider execution was not triggered/)).toBeTruthy()
    expect(refresh).toHaveBeenCalled()
  })
})
