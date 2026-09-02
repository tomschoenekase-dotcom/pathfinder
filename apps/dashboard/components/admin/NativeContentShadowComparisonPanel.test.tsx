/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ list: vi.fn(), compare: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      listNativeContentShadowRuns: { query: mocks.list },
      compareNativeContentShadowRuns: { query: mocks.compare },
    },
  }),
}))

import { NativeContentShadowComparisonPanel } from './NativeContentShadowComparisonPanel'

const props = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  releaseId: '11111111-1111-4111-8111-111111111111',
}
const runs = {
  baselines: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      createdAt: new Date(0),
      completedAt: new Date(1),
      modelProvider: 'openai',
      modelName: 'gpt-safe',
    },
  ],
  candidates: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      createdAt: new Date(2),
      completedAt: new Date(3),
      modelProvider: 'openai',
      modelName: 'gpt-safe',
    },
  ],
  bounded: true,
  advisoryOnly: true,
}
const readSwitchContract = {
  phase: 'POLICY_GATED',
  evidenceComplete: true,
  executable: false,
  readyForProductionSwitch: false,
  blockers: [
    'QUALITY_THRESHOLD_POLICY_UNSET',
    'READ_EXECUTOR_NOT_IMPLEMENTED',
    'PRODUCTION_APPROVAL_REQUIRED',
    'ROLLBACK_RUNTIME_NOT_PROVEN',
  ],
  rollback: {
    targetGuestReadPath: 'LEGACY_SEMANTIC_PLUS_NATIVE_GENERALIZED_PROMPT',
    compatibilityDataRetentionRequired: true,
    rehearsalRequired: true,
    automaticExecutionAuthorized: false,
  },
}

describe('NativeContentShadowComparisonPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.list.mockResolvedValue(runs)
    mocks.compare.mockResolvedValue({
      status: 'COMPARABLE_WITH_DECLARED_CHANGE',
      mismatchReasons: [],
      declaredChangeReasons: ['CONFIG', 'CONTENT'],
      cases: [
        {
          caseKey: 'admission-hours',
          caseRevision: 1,
          category: 'known-answer',
          classification: 'NEW_FAILURE',
          latencyDeltaMs: 10,
          costDeltaE8Usd: '20',
          scoreDeltaBasisPoints: -2500,
        },
      ],
      totals: {
        caseCount: 1,
        newFailures: 1,
        resolvedFailures: 0,
        unchangedFailures: 0,
        missingResults: 0,
        latencyDeltaMs: 10,
        costDeltaE8Usd: '20',
      },
      advisoryOnly: true,
      guestReadPathChanged: false,
      cutoverAuthorized: false,
      legacyRetirementAuthorized: false,
      readSwitchContract,
    })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('compares exact frozen runs and renders raw evidence without a cutover claim', async () => {
    render(<NativeContentShadowComparisonPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose frozen runs' }))
    await screen.findByLabelText('Legacy baseline run')
    fireEvent.click(screen.getByRole('button', { name: 'Compare frozen evidence' }))
    await screen.findByText('admission-hours')
    expect(mocks.list).toHaveBeenCalledWith(props, { signal: expect.any(AbortSignal) })
    expect(mocks.compare).toHaveBeenCalledWith(
      {
        ...props,
        baselineRunId: runs.baselines[0]!.id,
        candidateRunId: runs.candidates[0]!.id,
      },
      { signal: expect.any(AbortSignal) },
    )
    expect(screen.getByText(/No pass threshold is inferred/)).toBeTruthy()
    expect(screen.getByText(/does not switch guest retrieval/)).toBeTruthy()
    expect(screen.getByText(/· New failure · score/)).toBeTruthy()
    expect(screen.getByText('Non-executable read-switch contract')).toBeTruthy()
    expect(screen.getByText(/Founder-approved quality thresholds/)).toBeTruthy()
    expect(screen.getByText(/Rollback target: retained compatibility retrieval/)).toBeTruthy()
  })

  it('shows a bounded missing-evidence state and remains accessible', async () => {
    mocks.list.mockResolvedValue({ ...runs, baselines: [] })
    const { container } = render(<NativeContentShadowComparisonPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose frozen runs' }))
    await screen.findByText(/completed legacy baseline/)
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })

  it('fails closed on undeclared evidence differences', async () => {
    mocks.compare.mockResolvedValue({
      status: 'INCOMPARABLE',
      mismatchReasons: ['MODEL'],
      declaredChangeReasons: ['CONFIG', 'CONTENT'],
      cases: [],
      totals: null,
      advisoryOnly: true,
      guestReadPathChanged: false,
      cutoverAuthorized: false,
      legacyRetirementAuthorized: false,
      readSwitchContract: {
        ...readSwitchContract,
        phase: 'EVIDENCE_INCOMPLETE',
        evidenceComplete: false,
        blockers: ['SHADOW_EVIDENCE_INCOMPARABLE', ...readSwitchContract.blockers],
      },
    })
    render(<NativeContentShadowComparisonPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose frozen runs' }))
    await screen.findByLabelText('Native candidate run')
    fireEvent.click(screen.getByRole('button', { name: 'Compare frozen evidence' }))
    await waitFor(() => expect(screen.getByText(/model/)).toBeTruthy())
    expect(screen.queryByText(/Cases/)).toBeNull()
  })

  it('aborts an obsolete frozen-run read when the panel unmounts', async () => {
    let signal: AbortSignal | undefined
    mocks.list.mockImplementation((_input, options) => {
      signal = options.signal
      return new Promise(() => {})
    })
    const view = render(<NativeContentShadowComparisonPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose frozen runs' }))
    await waitFor(() => expect(signal).toBeDefined())
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('recovers with fixed guidance when comparison exceeds its deadline', async () => {
    const view = render(<NativeContentShadowComparisonPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose frozen runs' }))
    await screen.findByLabelText('Native candidate run')
    vi.useFakeTimers()
    mocks.compare.mockImplementation(() => new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Compare frozen evidence' }))
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(screen.getByRole('alert').textContent).toMatch(/could not be compared/i)
    expect(screen.queryByText(/secret provider detail/i)).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Compare frozen evidence' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
    view.unmount()
  })
})
