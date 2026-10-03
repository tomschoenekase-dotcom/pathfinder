/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => {
  const campaigns = vi.fn()
  const readiness = vi.fn()
  const requestReconciliation = vi.fn()
  const getReconciliation = vi.fn()
  return {
    campaigns,
    readiness,
    requestReconciliation,
    getReconciliation,
    client: {
      admin: {
        listProspectCampaigns: { query: campaigns },
        getProspectOutreachReadiness: { query: readiness },
        requestGmailReconciliation: { mutate: requestReconciliation },
        getGmailReconciliation: { query: getReconciliation },
      },
    },
  }
})

vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => mocks.client }))

import { ProspectOutreachCenter } from './ProspectOutreachCenter'

function readiness() {
  return {
    deliveryEnabled: false,
    internalOnly: true,
    providerConfigured: false,
    provider: 'GMAIL',
    accounts: [],
    limits: { cohort: 5000, batch: 500 },
    policy: { agentsMayDraft: true, agentsMayApprove: false, agentsMaySend: false },
    followupReview: {
      generatedAt: new Date('2026-08-22T12:00:00Z'),
      evidenceBounded: false,
      policy: {
        automaticSchedulingAuthorized: false,
        automaticSendingAuthorized: false,
        alternateContactAuthorized: false,
        cadencePolicy: 'UNRESOLVED',
      },
      counts: { due: 0, scheduled: 0, readyForDraft: 0, held: 0 },
      items: [],
    },
  }
}

describe('ProspectOutreachCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.campaigns.mockResolvedValue([])
    mocks.readiness.mockResolvedValue(readiness())
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('loads both readiness inputs through cancellable transport boundaries', async () => {
    render(<ProspectOutreachCenter />)
    expect(screen.getByRole('status').textContent).toMatch(/Loading outreach readiness/i)
    expect(await screen.findByText('No campaigns yet')).toBeTruthy()
    expect(mocks.campaigns).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal),
    })
    expect(mocks.readiness).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal),
    })
    expect(screen.getByText('Dark by default. No delivery can occur.')).toBeTruthy()
  })

  it('aborts both pending reads when the center unmounts', async () => {
    const signals: AbortSignal[] = []
    mocks.campaigns.mockImplementation((_input, options) => {
      signals.push(options.signal)
      return new Promise(() => {})
    })
    mocks.readiness.mockImplementation((_input, options) => {
      signals.push(options.signal)
      return new Promise(() => {})
    })
    const view = render(<ProspectOutreachCenter />)
    await waitFor(() => expect(signals).toHaveLength(2))
    view.unmount()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  it('shows fixed retry guidance instead of a false empty state after the deadline', async () => {
    vi.useFakeTimers()
    mocks.campaigns.mockImplementation(() => new Promise(() => {}))
    mocks.readiness.mockImplementation(() => new Promise(() => {}))
    render(<ProspectOutreachCenter />)
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded in time/i)
    expect(screen.getByRole('button', { name: 'Retry readiness' })).toBeTruthy()
    expect(screen.queryByText('No campaigns yet')).toBeNull()
  })

  it('contains provider failure details behind product-owned recovery copy', async () => {
    mocks.readiness.mockRejectedValue(new Error('secret provider detail'))
    render(<ProspectOutreachCenter />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(/secret provider detail/i)).toBeNull()
    expect(screen.queryByText('No campaigns yet')).toBeNull()
  })

  it('queues one mailbox reconciliation and shows its recorded result without provider secrets', async () => {
    mocks.readiness.mockResolvedValue({
      ...readiness(),
      accounts: [
        {
          id: 'account-1',
          mailboxAddress: 'example@example.test',
          connectionStatus: 'CONNECTED',
          deliveryEnabled: false,
          pausedAt: null,
          lastSuccessfulSyncAt: null,
          lastReconciliationAt: null,
          watchExpiration: null,
          healthErrorCode: null,
          healthErrorSummary: null,
        },
      ],
    })
    mocks.requestReconciliation.mockResolvedValue({
      jobId: `gmail-sync-${'a'.repeat(64)}`,
      status: 'QUEUED',
    })
    mocks.getReconciliation.mockResolvedValue({
      jobId: `gmail-sync-${'a'.repeat(64)}`,
      status: 'COMPLETE',
      processed: 3,
      complete: true,
      nextJobId: null,
      errorCode: null,
      completedAt: new Date(),
    })
    render(<ProspectOutreachCenter />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile mailbox' }))
    await waitFor(() =>
      expect(mocks.requestReconciliation).toHaveBeenCalledWith({
        providerAccountId: 'account-1',
        requestId: expect.any(String),
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Check result' }))
    expect(await screen.findByText(/3 messages handled in this job/iu)).toBeTruthy()
    expect(mocks.getReconciliation).toHaveBeenCalledWith(
      { providerAccountId: 'account-1', jobId: `gmail-sync-${'a'.repeat(64)}` },
      { signal: expect.any(AbortSignal) },
    )
  })
})
