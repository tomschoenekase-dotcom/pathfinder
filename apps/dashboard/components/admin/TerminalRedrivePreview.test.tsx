/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { previewTerminalJobRedrive: { query } } }),
}))

import { TerminalRedrivePreview } from './TerminalRedrivePreview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const preview = {
  schemaVersion: 1,
  effect: 'READ_ONLY',
  preview: {
    queueName: 'staging--weekly-report',
    bullJobId: 'weekly-report-report_1',
    jobName: 'weekly-report-process',
    terminalAt: '2026-08-23T12:00:00.000Z',
    attemptsMade: 6,
    attemptsStarted: 6,
    maxAttempts: 6,
    payloadDigest: 'b'.repeat(64),
    confirmationToken: `terminal-redrive-${'a'.repeat(64)}`,
  },
  boundaries: {
    environment: 'staging',
    payloadIncluded: false,
    errorDetailIncluded: false,
    retryAuthorized: false,
    cancellationAuthorized: false,
    incidentControlAuthorized: false,
    executionSurface: 'SEPARATELY_GATED_AUDITED_CLI',
  },
}

describe('TerminalRedrivePreview', () => {
  beforeEach(() => {
    query.mockReset()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('loads live evidence on demand and makes the no-mutation boundary explicit', async () => {
    query.mockResolvedValue(preview)
    render(<TerminalRedrivePreview jobRecordId="record_1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Preview staging recovery' }))

    await screen.findByText('Live failed-set evidence matches the persisted terminal record.')
    expect(query).toHaveBeenCalledWith(
      { jobRecordId: 'record_1' },
      { signal: expect.any(AbortSignal) },
    )
    expect(screen.getByText('weekly-report-report_1')).toBeTruthy()
    expect(screen.getByText(/No action was taken/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /execute|retry|redrive/i })).toBeNull()
  })

  it('shows a compact failure without leaving stale proof visible', async () => {
    query.mockRejectedValue(new Error('secret queue detail'))
    render(<TerminalRedrivePreview jobRecordId="record_1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Preview staging recovery' }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded in time/i),
    )
    expect(screen.queryByText(/secret queue detail/i)).toBeNull()
    expect(screen.queryByText(/Live failed-set evidence matches/)).toBeNull()
  })

  it('has no obvious accessibility violations before or after preview', async () => {
    query.mockResolvedValue(preview)
    const { container } = render(<TerminalRedrivePreview jobRecordId="record_1" />)
    const axeOptions = { rules: { 'color-contrast': { enabled: false } } }
    expect((await axe.run(container, axeOptions)).violations).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Preview staging recovery' }))
    await screen.findByText('Live failed-set evidence matches the persisted terminal record.')
    expect((await axe.run(container, axeOptions)).violations).toEqual([])
  })

  it('aborts a pending recovery read when the preview unmounts', async () => {
    let signal: AbortSignal | undefined
    query.mockImplementation((_input, options) => {
      signal = options.signal
      return new Promise(() => {})
    })
    const view = render(<TerminalRedrivePreview jobRecordId="record_1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview staging recovery' }))
    await waitFor(() => expect(signal).toBeDefined())
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('returns control after the recovery evidence deadline', async () => {
    vi.useFakeTimers()
    query.mockImplementation(() => new Promise(() => {}))
    render(<TerminalRedrivePreview jobRecordId="record_1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview staging recovery' }))
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded in time/i)
    expect(
      (screen.getByRole('button', { name: 'Preview staging recovery' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  })
})
