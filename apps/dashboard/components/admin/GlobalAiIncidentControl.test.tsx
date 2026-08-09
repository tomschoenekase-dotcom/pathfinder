/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: { setGlobalAiControl: { mutate: mocks.mutate } },
  }),
}))

import { GlobalAiIncidentControl } from './GlobalAiIncidentControl'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function codedError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code } })
}

const activeState = {
  paused: false,
  reason: null,
  configured: false,
  malformed: false,
  updatedAt: null,
  updatedBy: null,
}

describe('GlobalAiIncidentControl', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('requires a reason and sends the exact revision when pausing', async () => {
    mocks.mutate.mockResolvedValueOnce({
      paused: true,
      reason: 'Provider incident',
      configured: true,
      malformed: false,
      updatedAt: new Date('2026-08-08T20:01:00.000Z'),
      updatedBy: 'admin_1',
    })
    render(<GlobalAiIncidentControl initialState={activeState} />)

    const button = screen.getByRole('button', { name: 'Pause all AI' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Internal reason'), {
      target: { value: '  Provider incident  ' },
    })
    fireEvent.click(button)

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        paused: true,
        reason: 'Provider incident',
        expectedUpdatedAt: null,
      }),
    )
    expect(await screen.findByText('Global AI processing paused.')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('resumes only from the exact server revision shown', async () => {
    const revision = '2026-08-08T20:00:00.000Z'
    mocks.mutate.mockResolvedValueOnce({
      paused: false,
      reason: 'Incident resolved',
      configured: true,
      malformed: false,
      updatedAt: new Date('2026-08-08T20:05:00.000Z'),
      updatedBy: 'admin_2',
    })
    render(
      <GlobalAiIncidentControl
        initialState={{
          paused: true,
          reason: 'Incident resolved',
          configured: true,
          malformed: false,
          updatedAt: revision,
          updatedBy: 'admin_1',
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Resume all AI' }))

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        paused: false,
        reason: 'Incident resolved',
        expectedUpdatedAt: new Date(revision),
      }),
    )
  })

  it('shows fail-closed state and leaves a conflict visible', async () => {
    mocks.mutate.mockRejectedValueOnce(
      codedError('CONFLICT', 'This production message is deliberately opaque.'),
    )
    render(
      <GlobalAiIncidentControl
        initialState={{
          paused: true,
          reason: 'Repair malformed state',
          configured: true,
          malformed: true,
          updatedAt: '2026-08-08T20:00:00.000Z',
          updatedBy: null,
        }}
      />,
    )

    expect(screen.getByText('Fail-closed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Repair as paused' }))
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        paused: true,
        reason: 'Repair malformed state',
        expectedUpdatedAt: new Date('2026-08-08T20:00:00.000Z'),
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain('changed in another session')
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('admits one same-tick action, locks the surface while pending, and unlocks on success', async () => {
    const pending = deferred<{
      paused: boolean
      reason: string
      configured: boolean
      malformed: boolean
      updatedAt: Date
      updatedBy: string
    }>()
    mocks.mutate.mockReturnValueOnce(pending.promise)
    render(<GlobalAiIncidentControl initialState={activeState} />)
    const reason = screen.getByLabelText('Internal reason') as HTMLTextAreaElement
    fireEvent.change(reason, { target: { value: 'Provider outage' } })
    const pause = screen.getByRole('button', { name: 'Pause all AI' })

    act(() => {
      pause.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      pause.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.mutate).toHaveBeenCalledOnce()
    const section = screen.getByRole('heading', { name: 'Global AI' }).closest('section')
    expect(section?.getAttribute('aria-busy')).toBe('true')
    expect(reason.disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Saving...' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    pending.resolve({
      paused: true,
      reason: 'Provider outage',
      configured: true,
      malformed: false,
      updatedAt: new Date('2026-08-08T20:01:00.000Z'),
      updatedBy: 'admin_1',
    })
    expect((await screen.findByRole('status')).textContent).toContain(
      'Global AI processing paused.',
    )
    expect(section?.getAttribute('aria-busy')).toBe('false')
    expect((screen.getByLabelText('Internal reason') as HTMLTextAreaElement).disabled).toBe(false)
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it.each([
    {
      error: codedError('CONFLICT', 'A message that does not mention a conflict.'),
      expected: 'changed in another session',
    },
    {
      error: new Error('Global AI control changed; this looks like a conflict.'),
      expected: 'could not be confirmed',
    },
  ])('uses safe structured failure guidance: $expected', async ({ error, expected }) => {
    mocks.mutate.mockRejectedValueOnce(error)
    render(<GlobalAiIncidentControl initialState={activeState} />)
    fireEvent.change(screen.getByLabelText('Internal reason'), {
      target: { value: 'Investigate provider state' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pause all AI' }))

    expect((await screen.findByRole('alert')).textContent).toContain(expected)
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect((screen.getByLabelText('Internal reason') as HTMLTextAreaElement).value).toBe(
      'Investigate provider state',
    )
  })

  it('suppresses late state and router refresh after unmount', async () => {
    const pending = deferred<{
      paused: boolean
      reason: string
      configured: boolean
      malformed: boolean
      updatedAt: Date
      updatedBy: string
    }>()
    mocks.mutate.mockReturnValueOnce(pending.promise)
    const view = render(<GlobalAiIncidentControl initialState={activeState} />)
    fireEvent.change(screen.getByLabelText('Internal reason'), { target: { value: 'Outage' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pause all AI' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce())
    view.unmount()

    pending.resolve({
      paused: true,
      reason: 'Outage',
      configured: true,
      malformed: false,
      updatedAt: new Date('2026-08-08T20:01:00.000Z'),
      updatedBy: 'admin_1',
    })
    await act(async () => pending.promise)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('invalidates an old completion and clears stale draft and feedback when server props change', async () => {
    mocks.mutate.mockRejectedValueOnce(new Error('Transport unavailable'))
    const view = render(<GlobalAiIncidentControl initialState={activeState} />)
    const reason = screen.getByLabelText('Internal reason')
    fireEvent.change(reason, { target: { value: 'Old incident draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pause all AI' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()

    const pending = deferred<{
      paused: boolean
      reason: string
      configured: boolean
      malformed: boolean
      updatedAt: Date
      updatedBy: string
    }>()
    mocks.mutate.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Pause all AI' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2))
    view.rerender(
      <GlobalAiIncidentControl
        initialState={{
          paused: true,
          reason: 'Authoritative replacement',
          configured: true,
          malformed: false,
          updatedAt: '2026-08-08T20:10:00.000Z',
          updatedBy: 'admin_2',
        }}
      />,
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByLabelText('Internal reason') as HTMLTextAreaElement).value).toBe(
      'Authoritative replacement',
    )
    pending.resolve({
      paused: false,
      reason: 'Stale completion',
      configured: true,
      malformed: false,
      updatedAt: new Date('2026-08-08T20:11:00.000Z'),
      updatedBy: 'admin_1',
    })
    await act(async () => pending.promise)
    expect(screen.getByText('Paused')).toBeTruthy()
    expect((screen.getByLabelText('Internal reason') as HTMLTextAreaElement).value).toBe(
      'Authoritative replacement',
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
})
