/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  opened: vi.fn(),
  send: vi.fn(),
  confirmHandoff: vi.fn(),
  setPreference: vi.fn(),
}))

const trpcClient = vi.hoisted(() => ({
  clientAssistant: {
    bootstrap: { query: mocks.bootstrap },
    opened: { mutate: mocks.opened },
    send: { mutate: mocks.send },
    confirmHandoff: { mutate: mocks.confirmHandoff },
    setPreference: { mutate: mocks.setPreference },
  },
}))

vi.mock('../lib/browser-uuid', () => ({
  browserUuid: () => '11111111-1111-4111-8111-111111111111',
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/' }))
vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => trpcClient,
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

import { ClientTochiPreferenceWorkspace } from './ClientTochiPreferenceWorkspace'
import { ClientTochiWorkspace } from './ClientTochiWorkspace'

const bootstrap = {
  available: true,
  venues: [{ id: 'venue-1', name: 'Harbor Museum' }],
  selectedVenueId: 'venue-1',
  preference: { enabled: true, minimized: false, revision: 2 },
  history: [],
}

describe('ClientTochiWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.bootstrap.mockResolvedValue(bootstrap)
    mocks.opened.mockResolvedValue({ ok: true })
  })

  afterEach(() => cleanup())

  it('fails closed when rollout is unavailable', async () => {
    mocks.bootstrap.mockResolvedValue({
      ...bootstrap,
      available: false,
      venues: [],
      selectedVenueId: null,
    })
    render(<ClientTochiWorkspace />)
    await waitFor(() => expect(mocks.bootstrap).toHaveBeenCalledWith({}, expect.any(Object)))
    expect(mocks.bootstrap.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(screen.queryByRole('button', { name: 'Ask Tochi' })).toBeNull()
  })

  it('cancels the initial assistant read when the workspace unmounts', async () => {
    mocks.bootstrap.mockImplementation(() => new Promise(() => undefined))
    const view = render(<ClientTochiWorkspace />)
    await waitFor(() => expect(mocks.bootstrap).toHaveBeenCalledOnce())
    const signal = mocks.bootstrap.mock.calls[0]?.[1]?.signal as AbortSignal

    view.unmount()

    expect(signal.aborted).toBe(true)
  })

  it('sends through the bounded tenant API and renders a safe route action', async () => {
    mocks.send.mockResolvedValue({
      id: 'turn-1',
      answer: 'Your materials are under Information.',
      category: 'portal-navigation',
      action: { type: 'navigate', href: '/information', label: 'Open Information' },
    })
    render(<ClientTochiWorkspace />)
    await screen.findByRole('button', { name: 'Ask Tochi' })
    fireEvent.click(screen.getByRole('button', { name: 'Ask Tochi' }))
    fireEvent.change(screen.getByLabelText('Message Tochi'), {
      target: { value: 'Where are my uploads?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await screen.findByText('Your materials are under Information.')
    expect(mocks.send).toHaveBeenCalledWith({
      operationId: '11111111-1111-4111-8111-111111111111',
      venueId: 'venue-1',
      message: 'Where are my uploads?',
    })
    expect(screen.getByRole('link', { name: 'Open Information' }).getAttribute('href')).toBe(
      '/information',
    )
  })

  it('does not create a handoff until the client confirms the exact preview', async () => {
    mocks.send.mockResolvedValue({
      id: 'turn-2',
      answer: 'I prepared a request for your review.',
      category: 'support-handoff',
      action: {
        type: 'preview-support-handoff',
        category: 'OPERATIONAL_UPDATE',
        summary: 'Connect a POS system',
        requestedOutcome: 'Review available POS integration options.',
        relevantFeature: 'Venue Bot integrations',
      },
    })
    mocks.confirmHandoff.mockResolvedValue({ requestId: 'request-1' })
    render(<ClientTochiWorkspace />)
    await screen.findByRole('button', { name: 'Ask Tochi' })
    fireEvent.click(screen.getByRole('button', { name: 'Ask Tochi' }))
    fireEvent.change(screen.getByLabelText('Message Tochi'), {
      target: { value: 'Connect our POS' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await screen.findByRole('button', { name: 'Confirm and send' })
    expect(mocks.confirmHandoff).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }))
    await screen.findByText(/sent to the Torchiko team for review/i)
    expect(mocks.confirmHandoff).toHaveBeenCalledWith({
      operationId: '11111111-1111-4111-8111-111111111111',
      venueId: 'venue-1',
      turnId: 'turn-2',
      category: 'OPERATIONAL_UPDATE',
      summary: 'Connect a POS system',
      requestedOutcome: 'Review available POS integration options.',
      relevantFeature: 'Venue Bot integrations',
    })
  })

  it('persists the opt-out with optimistic revision in Account settings', async () => {
    mocks.setPreference.mockResolvedValue({ enabled: false, minimized: false, revision: 3 })
    render(<ClientTochiPreferenceWorkspace />)
    await screen.findByRole('button', { name: 'Off' })
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await screen.findByText('Tochi assistance is off.')
    expect(mocks.setPreference).toHaveBeenCalledWith({
      venueId: 'venue-1',
      enabled: false,
      minimized: false,
      expectedRevision: 2,
    })
  })

  it('reports a preference read failure without pretending assistance is unavailable', async () => {
    mocks.bootstrap.mockRejectedValueOnce(new Error('network unavailable'))
    render(<ClientTochiPreferenceWorkspace />)

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Assistance preference could not be loaded. Your existing setting was not changed.',
    )
    expect(
      screen.queryByText('This assistance is not enabled for your organization yet.'),
    ).toBeNull()
  })

  it('cancels the preference read when the settings surface unmounts', async () => {
    mocks.bootstrap.mockImplementation(() => new Promise(() => undefined))
    const view = render(<ClientTochiPreferenceWorkspace />)
    await waitFor(() => expect(mocks.bootstrap).toHaveBeenCalledOnce())
    const signal = mocks.bootstrap.mock.calls[0]?.[1]?.signal as AbortSignal

    view.unmount()

    expect(signal.aborted).toBe(true)
  })

  it('honors and persists the compact minimized preference without disabling Tochi', async () => {
    mocks.bootstrap.mockResolvedValue({
      ...bootstrap,
      preference: { enabled: true, minimized: true, revision: 2 },
    })
    mocks.setPreference.mockResolvedValue({ enabled: true, minimized: true, revision: 3 })
    render(<ClientTochiWorkspace />)
    const trigger = await screen.findByRole('button', { name: 'Tochi' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Minimize Tochi' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocks.setPreference).toHaveBeenCalledWith({
      venueId: 'venue-1',
      enabled: true,
      minimized: true,
      expectedRevision: 2,
    })
    expect(screen.getByRole('button', { name: 'Tochi' })).toBeTruthy()
  })

  it('makes multi-venue context explicit and reloads the exact selected venue', async () => {
    mocks.bootstrap
      .mockResolvedValueOnce({
        ...bootstrap,
        venues: [
          { id: 'venue-1', name: 'Harbor Museum' },
          { id: 'venue-2', name: 'River Museum' },
        ],
      })
      .mockResolvedValueOnce({
        ...bootstrap,
        venues: [
          { id: 'venue-1', name: 'Harbor Museum' },
          { id: 'venue-2', name: 'River Museum' },
        ],
        selectedVenueId: 'venue-2',
      })
    render(<ClientTochiWorkspace />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Tochi' }))
    await screen.findByRole('dialog', { name: 'Ask Tochi' })
    fireEvent.change(screen.getByLabelText('Venue context'), { target: { value: 'venue-2' } })
    await waitFor(() =>
      expect(mocks.bootstrap).toHaveBeenLastCalledWith({ venueId: 'venue-2' }, expect.any(Object)),
    )
    expect(mocks.bootstrap.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask Tochi' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Ask Tochi' }))
    expect(await screen.findByText(/Portal guidance for River Museum/)).toBeTruthy()
  })
})
