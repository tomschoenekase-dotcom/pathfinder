/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

describe('GlobalAiIncidentControl', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('requires a reason and sends the exact revision when pausing', async () => {
    mocks.mutate.mockResolvedValueOnce({
      paused: true,
      reason: 'Provider incident',
      configured: true,
      malformed: false,
      updatedAt: new Date('2026-08-08T20:01:00.000Z'),
      updatedBy: 'admin_1',
    })
    render(
      <GlobalAiIncidentControl
        initialState={{
          paused: false,
          reason: null,
          configured: false,
          malformed: false,
          updatedAt: null,
          updatedBy: null,
        }}
      />,
    )

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
      new Error('Global AI control changed; refresh and try again.'),
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
    expect(
      await screen.findByText('Global AI control changed; refresh and try again.'),
    ).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
})
