/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./EvaluationRunLifecycleControl', () => ({
  EvaluationRunLifecycleControl: ({ status }: { status: string }) => <span>{status}</span>,
}))
vi.mock('./EvaluationComparisonPanel', () => ({
  EvaluationComparisonPanel: () => <span>Comparison panel</span>,
}))

import { EvaluationOperationsView } from './EvaluationOperationsView'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const baseProps = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  humanConclusions: [],
  nextCursor: null,
}

const run = {
  id: '11111111-1111-4111-8111-111111111111',
  identityHash: 'a'.repeat(64),
  corpusHash: 'b'.repeat(64),
  promptContractVersion: 'prompt-v3',
  promptContractHash: 'c'.repeat(64),
  packageSnapshotRef: null,
  packageSnapshotHash: null,
  contentSnapshotVersion: 42n,
  contentSnapshotHash: 'd'.repeat(64),
  modelProvider: 'provider',
  modelName: 'model',
  modelSnapshotHash: 'e'.repeat(64),
  triggerType: 'MANUAL',
  status: 'COMPLETED' as const,
  attemptNumber: 1,
  maxAttempts: 3,
  startedAt: new Date('2026-08-11T12:00:01.000Z'),
  completedAt: new Date('2026-08-11T12:01:00.000Z'),
  cancellationRequestedAt: null,
  lastErrorCode: null,
  createdAt: new Date('2026-08-11T12:00:00.000Z'),
  summary: {
    resultCount: 8,
    quality: { scored: 6, passed: 4, failed: 2 },
    operational: { failures: 2, deferred: 0, budgetBlocked: 0, cancelled: 0 },
  },
}

describe('EvaluationOperationsView', () => {
  afterEach(cleanup)

  it('renders an honest empty state without an execution affordance', () => {
    render(<EvaluationOperationsView {...baseProps} runs={[]} />)

    expect(screen.getByText('No evaluation runs recorded')).toBeTruthy()
    expect(screen.getByText(/No evaluation was started by opening this page/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps scored quality and operational outcomes in separate labeled regions', () => {
    render(<EvaluationOperationsView {...baseProps} runs={[run]} />)

    expect(screen.getByText('Operationally incomplete')).toBeTruthy()
    const quality = screen.getByLabelText('Quality results')
    expect(within(quality).getByText('6 judged')).toBeTruthy()
    expect(within(quality).getByText('Passed')).toBeTruthy()
    expect(within(quality).getByText('Failed')).toBeTruthy()
    const operations = screen.getByLabelText('Operational outcomes')
    expect(within(operations).getByText('2 not scored')).toBeTruthy()
    expect(within(operations).getByText('Failures')).toBeTruthy()
  })

  it('shows frozen identities and bounded human conclusions', () => {
    render(
      <EvaluationOperationsView
        {...baseProps}
        runs={[run]}
        humanConclusions={[
          {
            id: 'review_1',
            reviewerId: 'operator_1',
            conclusion: 'Source coverage needs follow-up.',
            decision: 'NEEDS_FOLLOW_UP',
            rubricVersion: 'rubric-v2',
            revision: 1,
            createdAt: new Date('2026-08-11T13:00:00.000Z'),
            result: {
              runId: run.id,
              caseRevision: 3,
              evalCase: { caseKey: 'hours-question', category: 'grounding' },
            },
          },
        ]}
      />,
    )

    expect(screen.getByText('Frozen run identity')).toBeTruthy()
    expect(screen.getByText(/prompt-v3/)).toBeTruthy()
    expect(screen.getByText('Source coverage needs follow-up.')).toBeTruthy()
    expect(screen.getByText('NEEDS FOLLOW UP')).toBeTruthy()
  })
})
