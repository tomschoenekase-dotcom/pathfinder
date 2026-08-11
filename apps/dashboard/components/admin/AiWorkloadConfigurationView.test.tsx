/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AiWorkloadConfigurationView } from './AiWorkloadConfigurationView'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const data = {
  readOnly: true as const,
  scope: { tenantId: 'tenant-1', venueId: 'venue-1' },
  layers: [
    { level: 'PLATFORM' as const, availability: 'AVAILABLE' as const, detail: 'Registry active.' },
    { level: 'WORKLOAD' as const, availability: 'UNAVAILABLE' as const, detail: 'Not persisted.' },
    { level: 'CLIENT' as const, availability: 'UNAVAILABLE' as const, detail: 'Not persisted.' },
    { level: 'VENUE' as const, availability: 'UNAVAILABLE' as const, detail: 'Not persisted.' },
  ],
  budgetIntegration: { availability: 'UNAVAILABLE' as const, detail: 'Runtime gate is separate.' },
  workloads: [
    {
      workloadId: 'guest-chat',
      kind: 'TEXT' as const,
      provider: 'anthropic',
      model: 'configured-model',
      effectiveSource: 'PLATFORM' as const,
      fallback: { enabled: false, modelKeys: [] },
      requestBudgetCeilingE8Usd: null,
      pricingEstimate: {
        version: 'configured-pricing-v1',
        usdPerMillionTokens: { input: 1, output: 5 },
        invoiceAmount: false as const,
      },
      limits: {
        timeoutMs: 10_000,
        maxAttempts: 2,
        maxInputUtf8Bytes: 100,
        maxBillableInputTokens: 200,
        maxOutputTokens: 512,
      },
      unsafeChangesEnabled: false as const,
    },
  ],
}

describe('AiWorkloadConfigurationView', () => {
  afterEach(cleanup)

  it('shows truthful defaults, unavailable layers, and disabled safety states', () => {
    const { container } = render(<AiWorkloadConfigurationView data={data} />)

    expect(screen.getByRole('heading', { name: 'AI workloads' })).toBeTruthy()
    expect(screen.getByText('anthropic / configured-model')).toBeTruthy()
    expect(screen.getByText('Disabled')).toBeTruthy()
    expect(screen.getByText('Not configured')).toBeTruthy()
    expect(screen.getByText('Unsafe changes off')).toBeTruthy()
    expect(screen.getAllByText('unavailable')).toHaveLength(3)
    expect(container.textContent).not.toMatch(/api key|credential|secret/iu)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
