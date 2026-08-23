/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  afterEach(cleanup)

  it('loads live evidence on demand and makes the no-mutation boundary explicit', async () => {
    query.mockResolvedValue(preview)
    render(<TerminalRedrivePreview jobRecordId="record_1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Preview staging recovery' }))

    await screen.findByText('Live failed-set evidence matches the persisted terminal record.')
    expect(query).toHaveBeenCalledWith({ jobRecordId: 'record_1' })
    expect(screen.getByText('weekly-report-report_1')).toBeTruthy()
    expect(screen.getByText(/No action was taken/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /execute|retry|redrive/i })).toBeNull()
  })

  it('shows a compact failure without leaving stale proof visible', async () => {
    query.mockRejectedValue(new Error('Job is no longer failed'))
    render(<TerminalRedrivePreview jobRecordId="record_1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Preview staging recovery' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('no longer failed'))
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
})
