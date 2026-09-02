/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  cases: vi.fn(),
  request: vi.fn(),
  record: vi.fn(),
  evidence: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      listEvaluationCases: { query: mocks.cases },
      requestNativeVenueDeploymentEvaluation: { mutate: mocks.request },
      recordNativeVenueDeploymentEvaluationEvidence: { mutate: mocks.record },
      listNativeVenueDeploymentEvaluationEvidence: { query: mocks.evidence },
    },
  }),
}))

import { NativeReleaseEvaluationPanel } from './NativeReleaseEvaluationPanel'

const runner = {
  processEnabled: true,
  requiresDurableGlobalAdmission: true,
  requiresTenantAdmission: true,
  maximumCases: 50,
  maximumBudgetE8Usd: '100000000',
  advisoryOnly: true as const,
}
const props = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  releaseId: '11111111-1111-4111-8111-111111111111',
  releaseVersion: new Date('2026-08-12T12:00:00.000Z'),
  releaseStatus: 'APPROVED',
  runner,
  initialEvidence: { items: [], hasMore: false, nextCursor: null },
}
const caseItem = {
  id: '22222222-2222-4222-8222-222222222222',
  caseKey: 'arrival-question',
  revision: 2,
  category: 'navigation',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function selectCase() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose evaluation cases' }))
  await screen.findByText('arrival-question')
  fireEvent.click(screen.getByRole('checkbox', { name: /arrival-question/ }))
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm these cases and budget/ }))
}

describe('NativeReleaseEvaluationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '33333333-3333-4333-8333-333333333333',
    )
    mocks.cases.mockResolvedValue({ items: [caseItem], nextCursor: null })
    mocks.request.mockResolvedValue({
      runId: '44444444-4444-4444-8444-444444444444',
      status: 'STAGED',
      replayed: false,
      advisoryOnly: true,
    })
    mocks.record.mockResolvedValue({ disposition: 'PASS', replayed: false, advisoryOnly: true })
  })
  afterEach(cleanup)

  it('states the non-enforcing boundary and sends exact release/version facts without hashes', async () => {
    render(<NativeReleaseEvaluationPanel {...props} />)
    expect(screen.getByText(/do not approve, block, apply, revert, or change/)).toBeTruthy()
    expect(screen.getByText(/durable global admission/)).toBeTruthy()
    expect(screen.getByText(/exact tenant admission/)).toBeTruthy()
    expect(
      screen.getByText(/requirements, not claims that admission is currently enabled/),
    ).toBeTruthy()
    await selectCase()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Request evaluation of this release’s frozen desired state',
      }),
    )
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
    expect(mocks.request).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      releaseId: props.releaseId,
      expectedReleaseUpdatedAt: props.releaseVersion,
      operationId: '33333333-3333-4333-8333-333333333333',
      caseIds: [caseItem.id],
      budgetCeilingE8Usd: '25000000',
    })
    expect(JSON.stringify(mocks.request.mock.calls)).not.toMatch(/hash|provider|observation/iu)
  })

  it('fences same-tick duplicate requests and retains operation identity on ambiguous retry', async () => {
    mocks.request.mockRejectedValueOnce(new Error('provider://secret')).mockResolvedValueOnce({
      runId: '44444444-4444-4444-8444-444444444444',
      status: 'STAGED',
      replayed: true,
      advisoryOnly: true,
    })
    render(<NativeReleaseEvaluationPanel {...props} />)
    await selectCase()
    const button = screen.getByRole('button', {
      name: 'Request evaluation of this release’s frozen desired state',
    })
    fireEvent.click(button)
    fireEvent.click(button)
    await screen.findByText('Evaluation needs attention')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    fireEvent.click(button)
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2))
    expect(mocks.request.mock.calls[0]?.[0].operationId).toBe(
      mocks.request.mock.calls[1]?.[0].operationId,
    )
    expect(screen.queryByText(/provider:\/\/secret/)).toBeNull()
  })

  it('ignores a late request after the exact release version changes', async () => {
    const pending = deferred<unknown>()
    mocks.request.mockReturnValue(pending.promise)
    const { rerender } = render(<NativeReleaseEvaluationPanel {...props} />)
    await selectCase()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Request evaluation of this release’s frozen desired state',
      }),
    )
    rerender(
      <NativeReleaseEvaluationPanel
        {...props}
        releaseVersion={new Date('2026-08-12T12:01:00.000Z')}
      />,
    )
    await act(async () =>
      pending.resolve({
        runId: '44444444-4444-4444-8444-444444444444',
        status: 'STAGED',
        replayed: false,
        advisoryOnly: true,
      }),
    )
    expect(screen.queryByText(/Current run status/)).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('records completed evidence with a same-tick fence and stable ambiguous identity', async () => {
    mocks.record.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce({
      disposition: 'PASS',
      replayed: true,
      advisoryOnly: true,
    })
    render(<NativeReleaseEvaluationPanel {...props} />)
    await selectCase()
    fireEvent.click(
      screen.getByRole('button', {
        name: /Request evaluation of this release/,
      }),
    )
    const record = await screen.findByRole('button', {
      name: 'Check and record completed evidence',
    })
    fireEvent.click(record)
    fireEvent.click(record)
    await screen.findByText('Evaluation needs attention')
    expect(mocks.record).toHaveBeenCalledTimes(1)
    fireEvent.click(record)
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(2))
    expect(mocks.record.mock.calls[0]?.[0].operationId).toBe(
      mocks.record.mock.calls[1]?.[0].operationId,
    )
    expect(mocks.record.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      releaseId: props.releaseId,
      runId: '44444444-4444-4444-8444-444444444444',
    })
  })

  it('renders only bounded aggregate evidence and keeps quality separate from operations', () => {
    render(
      <NativeReleaseEvaluationPanel
        {...props}
        initialEvidence={{
          items: [
            {
              id: 'evidence-1',
              runId: 'run-1',
              disposition: 'QUALITY_FAILURE',
              manifestCaseCount: 4,
              scoredCaseCount: 3,
              passedCaseCount: 2,
              failedCaseCount: 1,
              operationalFailureCount: 1,
              totalLatencyMs: 120,
              totalCostE8Usd: '10000',
              runCompletedAt: new Date(0),
              createdAt: new Date(0),
              advisoryOnly: true,
              observation: 'must not render',
              provider: 'must not render',
              identityHash: 'must not render',
            } as never,
          ],
          hasMore: false,
          nextCursor: null,
        }}
      />,
    )
    expect(screen.getByText('Quality checks found failures')).toBeTruthy()
    expect(
      screen.getByText(/2 passed · 1 failed · 1 operational failures · 3 of 4 scored/),
    ).toBeTruthy()
    expect(screen.queryByText('must not render')).toBeNull()
  })

  it('loads the next evidence keyset once across same-tick activation', async () => {
    const pending = deferred<{
      items: never[]
      hasMore: boolean
      nextCursor: null
    }>()
    mocks.evidence.mockReturnValue(pending.promise)
    const cursor = {
      createdAt: new Date('2026-08-12T11:00:00.000Z'),
      id: '55555555-5555-4555-8555-555555555555',
    }
    render(
      <NativeReleaseEvaluationPanel
        {...props}
        initialEvidence={{ items: [], hasMore: true, nextCursor: cursor }}
      />,
    )
    const button = screen.getByRole('button', { name: 'Load older evidence' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(mocks.evidence).toHaveBeenCalledTimes(1))
    expect(mocks.evidence).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        releaseId: props.releaseId,
        cursor,
        limit: 10,
      },
      { signal: expect.any(AbortSignal) },
    )
    await act(async () => pending.resolve({ items: [], hasMore: false, nextCursor: null }))
  })

  it('uses one synchronous fence across distinct read and mutation controls', async () => {
    const pending = deferred<{ items: never[]; hasMore: boolean; nextCursor: null }>()
    mocks.evidence.mockReturnValue(pending.promise)
    const cursor = {
      createdAt: new Date('2026-08-12T11:00:00.000Z'),
      id: '55555555-5555-4555-8555-555555555555',
    }
    render(
      <NativeReleaseEvaluationPanel
        {...props}
        initialEvidence={{ items: [], hasMore: true, nextCursor: cursor }}
      />,
    )
    const history = screen.getByRole('button', { name: 'Load older evidence' })
    const cases = screen.getByRole('button', { name: 'Choose evaluation cases' })
    fireEvent.click(history)
    fireEvent.click(cases)
    await waitFor(() => expect(mocks.evidence).toHaveBeenCalledTimes(1))
    expect(mocks.cases).not.toHaveBeenCalled()
    expect(
      screen
        .getByRole('region', { name: 'Advisory evaluation evidence' })
        .getAttribute('aria-busy'),
    ).toBe('true')
    await act(async () => pending.resolve({ items: [], hasMore: false, nextCursor: null }))
    expect(
      screen
        .getByRole('region', { name: 'Advisory evaluation evidence' })
        .getAttribute('aria-busy'),
    ).toBe('false')
  })

  it('cancels an in-flight case read when the release panel unmounts', async () => {
    let signal: AbortSignal | undefined
    mocks.cases.mockImplementationOnce((_input: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise(() => undefined)
    })
    const rendered = render(<NativeReleaseEvaluationPanel {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose evaluation cases' }))
    await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal))
    expect(signal?.aborted).toBe(false)
    rendered.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('has no automated accessibility violations', async () => {
    const { container } = render(<NativeReleaseEvaluationPanel {...props} />)
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
