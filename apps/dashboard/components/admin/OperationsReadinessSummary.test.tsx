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
  performance: {
    complete: true,
    jobs: {
      terminal: 12,
      completed: 10,
      failed: 2,
      retryAttempts: 3,
      processingMs: { observed: 12, p50: 400, p95: 2400 },
    },
    provider: {
      requests: 4,
      successful: 3,
      failed: 1,
      retryAttempts: 1,
      latencyMs: { observed: 4, p50: 800, p95: 3100 },
      estimatedCostUsd: '0.12345678',
    },
  },
  stuckCriticalJobs: 2,
  queue: {
    persisted: { source: 'persisted-job-records' },
    live: {
      status: 'observed',
      pausedQueues: 1,
      totalDepth: 5,
      totalFailed: 2,
      oldestAgeMs: 12_000,
    },
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
    expect(screen.getByText('Terminal jobs / 60 min').parentElement?.textContent).toContain('12')
    expect(screen.getByText('Live queue').parentElement?.textContent).toContain('5 queued')
    expect(screen.getByText('Provider wait').parentElement?.textContent).toContain('p95 3.1 s')
    expect(screen.getByText('Estimated provider cost').parentElement?.textContent).toContain(
      '$0.12345678',
    )
  })

  it('has no automated accessibility violations', async () => {
    const { container } = render(<OperationsReadinessSummary readiness={readiness} />)
    expect((await axe.run(container)).violations).toEqual([])
  })
})
