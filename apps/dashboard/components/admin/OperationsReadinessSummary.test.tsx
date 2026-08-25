/* @vitest-environment jsdom */
import React from 'react'
import { render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { describe, expect, it } from 'vitest'

import { OperationsReadinessSummary } from './OperationsReadinessSummary'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const readiness = {
  schemaVersion: 'pathfinder.operations-readiness.v4',
  status: 'degraded',
  requirements: {
    databaseConnected: true,
    redisConnected: true,
    migrationParity: true,
    workerHeartbeatFresh: true,
    schedulersEnabled: false,
    providerWorkEnabled: false,
    allQueuesObserved: true,
    noQueuesPaused: false,
    noStuckCriticalJobs: false,
    intakeVerificationEnabled: true,
    objectStorageConnected: true,
    malwareScannerConnected: true,
  },
  probes: { database: 'up', redis: 'up' },
  observedAt: new Date('2026-08-24T04:00:00.000Z'),
  migration: { parity: true },
  worker: { revision: 'revision-1' },
  scheduler: { status: 'reported-with-worker-heartbeat' },
  serviceDependencies: {
    state: 'FRESH',
    fresh: true,
    intakeVerificationRequired: true,
    objectStorage: 'up',
    malwareScanner: 'up',
  },
  objectStorage: { status: 'not-observed' },
  malwareScanning: null,
  aiProviderOutcomes: [],
  embeddingOutcomes: [],
  emailProviderOutcome: null,
  stuckCriticalJobs: 2,
  queue: {
    persisted: { source: 'persisted-job-records' },
    live: { status: 'observed', pausedQueues: 1 },
  },
  boundaries: {},
} as never

describe('operations readiness summary', () => {
  it('surfaces false-green blockers in a compact founder view', () => {
    render(<OperationsReadinessSummary readiness={readiness} />)

    expect(screen.getByRole('heading', { name: 'Core operations need attention' })).toBeTruthy()
    expect(screen.getByText('Provider work').parentElement?.textContent).toContain(
      'Needs attention',
    )
    expect(screen.getByText('Paused queues').parentElement?.textContent).toContain('1')
    expect(screen.getByText('Long-running jobs').parentElement?.textContent).toContain('2')
    expect(screen.getByText('Object storage').parentElement?.textContent).toContain('Ready')
    expect(screen.getByText(/does not prove AI-provider execution/i)).toBeTruthy()
  })

  it('has no automated accessibility violations', async () => {
    const { container } = render(<OperationsReadinessSummary readiness={readiness} />)
    expect((await axe.run(container)).violations).toEqual([])
  })
})
