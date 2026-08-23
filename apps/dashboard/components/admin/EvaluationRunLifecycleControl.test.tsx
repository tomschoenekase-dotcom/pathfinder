/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ cancel: vi.fn(), refresh: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { cancelEvaluationRun: { mutate: mocks.cancel } } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { EvaluationRunLifecycleControl } from './EvaluationRunLifecycleControl'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('moves focus into confirmation and restores it when confirmation closes', async () => {
  render(
    <EvaluationRunLifecycleControl
      tenantId="tenant-1"
      venueId="venue-1"
      runId="run-1"
      status="RUNNING"
      cancellationRequestedAt={null}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Cancel remaining cases' }))
  const confirm = await screen.findByRole('button', { name: 'Confirm cancellation' })
  await waitFor(() => expect(document.activeElement).toBe(confirm))
  fireEvent.click(screen.getByRole('button', { name: 'Keep running' }))
  const open = screen.getByRole('button', { name: 'Cancel remaining cases' })
  await waitFor(() => expect(document.activeElement).toBe(open))
})

it('resets confirmation and ignores a late mutation after the run identity changes', async () => {
  let resolve!: () => void
  mocks.cancel.mockReturnValueOnce(new Promise<void>((done) => (resolve = done)))
  const view = render(
    <EvaluationRunLifecycleControl
      tenantId="tenant-1"
      venueId="venue-1"
      runId="run-1"
      status="RUNNING"
      cancellationRequestedAt={null}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Cancel remaining cases' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm cancellation' }))
  view.rerender(
    <EvaluationRunLifecycleControl
      tenantId="tenant-1"
      venueId="venue-1"
      runId="run-2"
      status="RUNNING"
      cancellationRequestedAt={null}
    />,
  )
  expect(screen.getByRole('button', { name: 'Cancel remaining cases' })).toBeTruthy()
  resolve()
  await Promise.resolve()
  expect(screen.queryByText(/Cancellation requested/)).toBeNull()
  expect(mocks.refresh).not.toHaveBeenCalled()
})

it('restores focus to the cancellation trigger after a successful request', async () => {
  mocks.cancel.mockResolvedValueOnce(undefined)
  render(
    <EvaluationRunLifecycleControl
      tenantId="tenant-1"
      venueId="venue-1"
      runId="run-1"
      status="RUNNING"
      cancellationRequestedAt={null}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Cancel remaining cases' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm cancellation' }))
  const open = await screen.findByRole('button', { name: 'Cancel remaining cases' })
  await waitFor(() => expect(document.activeElement).toBe(open))
})

it('fences same-tick duplicate cancellation activation', async () => {
  let resolve!: () => void
  mocks.cancel.mockReturnValueOnce(new Promise<void>((done) => (resolve = done)))
  render(
    <EvaluationRunLifecycleControl
      tenantId="tenant-1"
      venueId="venue-1"
      runId="run-1"
      status="RUNNING"
      cancellationRequestedAt={null}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Cancel remaining cases' }))
  const confirm = await screen.findByRole('button', { name: 'Confirm cancellation' })
  fireEvent.click(confirm)
  fireEvent.click(confirm)
  expect(mocks.cancel).toHaveBeenCalledTimes(1)
  resolve()
})
