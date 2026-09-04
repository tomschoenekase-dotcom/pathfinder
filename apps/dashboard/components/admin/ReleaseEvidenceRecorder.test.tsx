/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ record: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { recordReleaseEvidence: { mutate: mocks.record } } }),
}))

import { ReleaseEvidenceRecorder } from './ReleaseEvidenceRecorder'

const payload = {
  operationId: '379f85e4-d011-53d4-8cc4-209537af0175',
  assessment: {
    schemaVersion: 1,
    generatedAt: '2026-09-04T09:21:32.954Z',
    revision: 'e56f17b4bcfc57109f214900a74fedeb6968958d',
    profile: 'candidate',
    readiness: 'ready-for-staging-review',
    repository: { clean: true },
    summary: { passed: 1, failed: 0, blocked: 0 },
    gates: [{ id: 'typecheck', status: 'pass', durationMs: 100 }],
    limitations: ['Hosted behavior remains separately verified.'],
    rollback: {
      application: 'Redeploy the last admitted staging revision.',
      database: 'Repair forward.',
      runbook: 'docs/staging-release-workflow.md',
    },
  },
  stagingHandoff: null,
  sourceReference: 'artifacts/release-verification/exact-candidate.json',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

async function validatePayload(value: unknown = payload) {
  fireEvent.change(screen.getByLabelText('Prepared release-evidence JSON'), {
    target: { value: JSON.stringify(value) },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Check payload' }))
  if (value === payload) await screen.findByText(payload.assessment.revision)
}

describe('ReleaseEvidenceRecorder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.record.mockResolvedValue({ replayed: false })
  })
  afterEach(cleanup)

  it('fails closed on malformed or structurally invalid payloads', async () => {
    render(<ReleaseEvidenceRecorder />)
    fireEvent.click(screen.getByText('Record a verified release assessment'))
    await validatePayload({ operationId: payload.operationId })
    expect(screen.getByRole('heading', { name: 'Release evidence needs attention' })).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Record immutable evidence' }).disabled,
    ).toBe(true)
  })

  it('previews the exact revision and records the unchanged validated payload', async () => {
    render(<ReleaseEvidenceRecorder />)
    fireEvent.click(screen.getByText('Record a verified release assessment'))
    await validatePayload()
    expect(screen.getByText(payload.assessment.revision)).toBeTruthy()
    expect(screen.getByText(/Validated candidate assessment for e56f17b4/)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Record it as immutable evidence only/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Record immutable evidence' }))
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1))
    expect(mocks.record.mock.calls[0]?.[0]).toEqual(payload)
    expect(mocks.record.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('fences same-tick duplicates and keeps the exact operation identity on ambiguous retry', async () => {
    const pending = deferred<never>()
    mocks.record.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ replayed: true })
    render(<ReleaseEvidenceRecorder />)
    fireEvent.click(screen.getByText('Record a verified release assessment'))
    await validatePayload()
    fireEvent.click(screen.getByRole('checkbox', { name: /Record it as immutable evidence only/ }))
    const button = screen.getByRole('button', { name: 'Record immutable evidence' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1))
    await act(async () => pending.reject(new Error('connection lost')))
    await screen.findByRole('heading', { name: 'Release evidence needs attention' })
    fireEvent.click(button)
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(2))
    expect(mocks.record.mock.calls[0]?.[0].operationId).toBe(
      mocks.record.mock.calls[1]?.[0].operationId,
    )
  })

  it('cancels an in-flight record when the control unmounts', async () => {
    let signal: AbortSignal | undefined
    mocks.record.mockImplementationOnce((_input: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise(() => undefined)
    })
    const rendered = render(<ReleaseEvidenceRecorder />)
    fireEvent.click(screen.getByText('Record a verified release assessment'))
    await validatePayload()
    fireEvent.click(screen.getByRole('checkbox', { name: /Record it as immutable evidence only/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Record immutable evidence' }))
    await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal))
    rendered.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('has no automated accessibility violations', async () => {
    const { container } = render(<ReleaseEvidenceRecorder />)
    fireEvent.click(screen.getByText('Record a verified release assessment'))
    await validatePayload()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
