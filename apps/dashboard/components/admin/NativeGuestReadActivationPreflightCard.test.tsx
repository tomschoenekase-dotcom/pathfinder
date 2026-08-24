/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { NativeGuestReadActivationPreflightCard } from './NativeGuestReadActivationPreflightCard'

const preflight = {
  contractVersion: 1,
  activation: {
    runtime: { serverGateEnabled: false, production: false },
    policy: {
      enabled: true,
      valid: true,
      mode: 'DARK',
      productionApprovalReferencePresent: false,
    },
    head: { valid: true, targetMatches: true },
    evaluation: { valid: true },
    path: 'LEGACY',
    nativeExecutionReady: false,
    blockers: ['SERVER_GATE_DISABLED'],
  },
  convergence: {
    phase: 'NATIVE_HEAD_IN_SYNC',
    blockers: ['LEGACY_SEMANTIC_READ_PATH'],
  },
  alignment: {
    runtimeReadGateOpen: false,
    materializedStateInSync: true,
    allObservedTechnicalEvidenceAligned: false,
  },
} as never

describe('NativeGuestReadActivationPreflightCard', () => {
  afterEach(cleanup)

  it('renders compact read-only evidence and retained authority boundaries', () => {
    render(<NativeGuestReadActivationPreflightCard preflight={preflight} />)
    expect(screen.getByText('Guest read activation preflight')).toBeTruthy()
    expect(screen.getByText(/Server Gate Disabled/)).toBeTruthy()
    expect(screen.getByText(/Legacy Semantic Read Path/)).toBeTruthy()
    expect(screen.getByText(/cannot activate a feature/i)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('fails closed with an explicit empty state', () => {
    render(<NativeGuestReadActivationPreflightCard preflight={null} />)
    expect(screen.getByRole('heading', { name: /preflight unavailable/i })).toBeTruthy()
    expect(screen.getByText(/compatibility reads remain the safe assumption/i)).toBeTruthy()
  })

  it('has no automated accessibility violations', async () => {
    const { container } = render(<NativeGuestReadActivationPreflightCard preflight={preflight} />)
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
