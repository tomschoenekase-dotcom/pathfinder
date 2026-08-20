/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ compare: vi.fn(), append: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      compareEvaluationRuns: { query: mocks.compare },
      appendEvaluationConclusion: { mutate: mocks.append },
    },
  }),
}))

import { EvaluationComparisonPanel } from './EvaluationComparisonPanel'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const runs = [
  {
    id: '22222222-2222-4222-8222-222222222222',
    identityHash: 'b'.repeat(64),
    createdAt: new Date('2026-08-12T11:00:00Z'),
    modelProvider: 'openai',
    modelName: 'candidate',
  },
  {
    id: '11111111-1111-4111-8111-111111111111',
    identityHash: 'a'.repeat(64),
    createdAt: new Date('2026-08-12T10:00:00Z'),
    modelProvider: 'openai',
    modelName: 'baseline',
  },
]

const comparable = {
  status: 'COMPARABLE' as const,
  baseline: { ...runs[1], status: 'COMPLETED', contentSnapshotVersion: '2' },
  candidate: { ...runs[0], status: 'COMPLETED', contentSnapshotVersion: '2' },
  mismatchReasons: [],
  totals: {
    caseCount: 1,
    newFailures: 1,
    resolvedFailures: 0,
    unchangedFailures: 0,
    missingResults: 0,
    baselineLatencyMs: 100,
    candidateLatencyMs: 130,
    latencyDeltaMs: 30,
    baselineCostE8Usd: '1000',
    candidateCostE8Usd: '1200',
    costDeltaE8Usd: '200',
  },
  cases: [
    {
      caseKey: 'hours-question',
      caseRevision: 2,
      category: 'grounding',
      classification: 'NEW_FAILURE' as const,
      baseline: {
        resultId: '33333333-3333-4333-8333-333333333333',
        outcome: 'SCORED',
        passed: true,
        errorCode: null,
        latencyMs: 100,
        costE8Usd: '1000',
        scoreBasisPoints: 10000,
      },
      candidate: {
        resultId: '44444444-4444-4444-8444-444444444444',
        outcome: 'SCORED',
        passed: false,
        errorCode: null,
        latencyMs: 130,
        costE8Usd: '1200',
        scoreBasisPoints: 5000,
        latestReviewRevision: 0,
      },
      latencyDeltaMs: 30,
      costDeltaE8Usd: '200',
      scoreDeltaBasisPoints: -5000,
    },
  ],
}
const candidateRun = runs[0]!
const candidateCase = comparable.cases[0]!

describe('EvaluationComparisonPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { randomUUID: vi.fn(() => '55555555-5555-4555-8555-555555555555') },
    })
  })
  afterEach(cleanup)

  it('renders explicit INCOMPARABLE evidence and no review controls', async () => {
    mocks.compare.mockResolvedValue({
      status: 'INCOMPARABLE',
      baseline: comparable.baseline,
      candidate: comparable.candidate,
      mismatchReasons: ['CONTENT', 'MODEL'],
      cases: [],
      totals: null,
    })
    render(<EvaluationComparisonPanel tenantId="tenant-1" venueId="venue-1" runs={runs} />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare runs' }))
    expect(await screen.findByText('Runs are incomparable')).toBeTruthy()
    expect(screen.getByText(/content, model/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Record conclusion' })).toBeNull()
  })

  it('shows classifications and appends an exact candidate conclusion', async () => {
    mocks.compare.mockResolvedValue(comparable)
    mocks.append.mockResolvedValue({
      id: '55555555-5555-4555-8555-555555555555',
      resultId: candidateCase.candidate.resultId,
      reviewerId: 'admin-1',
      conclusion: 'Investigate this regression.',
      decision: 'NEEDS_FOLLOW_UP',
      rubricVersion: 'operator-v1',
      revision: 1,
      createdAt: new Date(),
      replayed: false,
      result: {
        runId: candidateRun.id,
        caseRevision: 2,
        evalCase: { caseKey: 'hours-question', category: 'grounding' },
      },
    })
    render(<EvaluationComparisonPanel tenantId="tenant-1" venueId="venue-1" runs={runs} />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare runs' }))
    const cases = await screen.findByRole('list', { name: 'Per-case comparison' })
    expect(within(cases).getByText('New failure')).toBeTruthy()
    expect(within(cases).getByText(/Latency \+30 ms/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Conclusion for hours-question/), {
      target: { value: 'Investigate this regression.' },
    })
    const recordConclusion = screen.getByRole('button', { name: 'Record conclusion' })
    await waitFor(() => expect((recordConclusion as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(recordConclusion)
    await waitFor(() =>
      expect(mocks.append).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        runId: candidateRun.id,
        expectedRunIdentityHash: candidateRun.identityHash,
        resultId: candidateCase.candidate.resultId,
        expectedRevision: 0,
        operationId: '55555555-5555-4555-8555-555555555555',
        decision: 'NEEDS_FOLLOW_UP',
        conclusion: 'Investigate this regression.',
        rubricVersion: 'operator-v1',
      }),
    )
    expect(await screen.findByText('Conclusion recorded.')).toBeTruthy()
    expect(screen.getByText(/current revision 1/)).toBeTruthy()
  })

  it('retains the same operation identity across an ambiguous unchanged retry', async () => {
    mocks.compare.mockResolvedValue(comparable)
    mocks.append
      .mockRejectedValueOnce(new Error('Network response was lost'))
      .mockResolvedValueOnce({
        id: '55555555-5555-4555-8555-555555555555',
        resultId: candidateCase.candidate.resultId,
        reviewerId: 'admin-1',
        conclusion: 'Retry unchanged.',
        decision: 'NEEDS_FOLLOW_UP',
        rubricVersion: 'operator-v1',
        revision: 1,
        createdAt: new Date(),
        replayed: true,
        result: {
          runId: candidateRun.id,
          caseRevision: 2,
          evalCase: { caseKey: 'hours-question', category: 'grounding' },
        },
      })
    render(<EvaluationComparisonPanel tenantId="tenant-1" venueId="venue-1" runs={runs} />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare runs' }))
    await screen.findByText('New failure')
    fireEvent.change(screen.getByLabelText(/Conclusion for hours-question/), {
      target: { value: 'Retry unchanged.' },
    })
    const recordConclusion = screen.getByRole('button', { name: 'Record conclusion' })
    await waitFor(() => expect((recordConclusion as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(recordConclusion)
    expect(await screen.findByText(/Network response was lost/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Record conclusion' }))
    await waitFor(() => expect(mocks.append).toHaveBeenCalledTimes(2))
    expect(mocks.append.mock.calls[0]![0].operationId).toBe(
      mocks.append.mock.calls[1]![0].operationId,
    )
    expect(await screen.findByText('This exact conclusion was already recorded.')).toBeTruthy()
  })

  it('has no detectable axe violations for comparable evidence and review form', async () => {
    mocks.compare.mockResolvedValue(comparable)
    const { container } = render(
      <main>
        <EvaluationComparisonPanel tenantId="tenant-1" venueId="venue-1" runs={runs} />
      </main>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Compare runs' }))
    await screen.findByText('New failure')
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])
  })

  it('cancels busy comparison state and ignores a late response when selection changes', async () => {
    let resolve!: (value: typeof comparable) => void
    mocks.compare.mockReturnValueOnce(new Promise((done) => (resolve = done)))
    render(<EvaluationComparisonPanel tenantId="tenant-1" venueId="venue-1" runs={runs} />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare runs' }))
    expect(screen.getByRole('button', { name: 'Comparing…' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Baseline run'), { target: { value: runs[0]!.id } })
    expect(screen.getByRole('button', { name: 'Compare runs' })).toBeTruthy()
    resolve(comparable)
    await Promise.resolve()
    expect(screen.queryByText('New failure')).toBeNull()
  })

  it('fences same-tick duplicate comparison and conclusion activation', async () => {
    let resolveCompare!: (value: typeof comparable) => void
    mocks.compare.mockReturnValueOnce(new Promise((done) => (resolveCompare = done)))
    render(<EvaluationComparisonPanel tenantId="tenant-1" venueId="venue-1" runs={runs} />)
    const compare = screen.getByRole('button', { name: 'Compare runs' })
    fireEvent.click(compare)
    fireEvent.click(compare)
    expect(mocks.compare).toHaveBeenCalledTimes(1)
    resolveCompare(comparable)
    await screen.findByText('New failure')

    let resolveAppend!: (value: unknown) => void
    mocks.append.mockReturnValueOnce(new Promise((done) => (resolveAppend = done)))
    fireEvent.change(screen.getByLabelText(/Conclusion for hours-question/), {
      target: { value: 'One conclusion.' },
    })
    const append = screen.getByRole('button', { name: 'Record conclusion' })
    await waitFor(() => expect((append as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(append)
    fireEvent.click(append)
    expect(mocks.append).toHaveBeenCalledTimes(1)
    resolveAppend({ revision: 1, replayed: false })
  })

  it('ignores a late conclusion response after candidate scope changes', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof mocks.append>>) => void
    mocks.compare.mockResolvedValue(comparable)
    mocks.append.mockReturnValueOnce(new Promise((done) => (resolve = done)))
    const view = render(
      <EvaluationComparisonPanel tenantId="tenant-1" venueId="venue-1" runs={runs} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Compare runs' }))
    await screen.findByText('New failure')
    fireEvent.change(screen.getByLabelText(/Conclusion for hours-question/), {
      target: { value: 'Old scope conclusion.' },
    })
    const recordConclusion = screen.getByRole('button', { name: 'Record conclusion' })
    await waitFor(() => expect((recordConclusion as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(recordConclusion)
    view.rerender(<EvaluationComparisonPanel tenantId="tenant-2" venueId="venue-2" runs={runs} />)
    resolve({ revision: 1, replayed: false } as never)
    await Promise.resolve()
    expect(screen.queryByText('Conclusion recorded.')).toBeNull()
  })
})
