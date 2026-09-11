/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const secondTrpcClient = vi.hoisted(() => ({
  clientAssistant: {
    bootstrap: { query: vi.fn() },
    opened: { mutate: vi.fn() },
    send: { mutate: vi.fn() },
    confirmHandoff: { mutate: vi.fn() },
    setPreference: { mutate: vi.fn() },
  },
}))
const currentClient = vi.hoisted(() => ({ value: trpcClient }))
let pathname = '/'
let searchParams = new URLSearchParams()

vi.mock('../lib/browser-uuid', () => ({
  browserUuid: () => '11111111-1111-4111-8111-111111111111',
}))
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => searchParams,
}))
vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => currentClient.value,
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
    currentClient.value = trpcClient
    pathname = '/'
    searchParams = new URLSearchParams()
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

  it('reboots the bounded workspace when a venue query changes on the same path', async () => {
    searchParams = new URLSearchParams({ venue: 'venue-1' })
    mocks.bootstrap.mockResolvedValueOnce(bootstrap).mockResolvedValueOnce({
      ...bootstrap,
      venues: [
        { id: 'venue-1', name: 'Harbor Museum' },
        { id: 'venue-2', name: 'River Museum' },
      ],
      selectedVenueId: 'venue-2',
    })
    const view = render(<ClientTochiWorkspace />)
    await screen.findByRole('button', { name: 'Ask Tochi' })
    expect(mocks.bootstrap).toHaveBeenLastCalledWith({ venueId: 'venue-1' }, expect.any(Object))

    searchParams = new URLSearchParams({ venue: 'venue-2' })
    view.rerender(<ClientTochiWorkspace />)

    await waitFor(() =>
      expect(mocks.bootstrap).toHaveBeenLastCalledWith({ venueId: 'venue-2' }, expect.any(Object)),
    )
    await screen.findByRole('button', { name: 'Ask Tochi' })
  })

  it('gives a decoded route venue precedence over an unrelated venue query', async () => {
    pathname = '/venues/venue%20%2F%201/onboarding'
    searchParams = new URLSearchParams({ venue: 'venue-other' })
    mocks.bootstrap.mockResolvedValueOnce({
      ...bootstrap,
      venues: [{ id: 'venue / 1', name: 'Encoded Route Venue' }],
      selectedVenueId: 'venue / 1',
    })

    render(<ClientTochiWorkspace />)

    await waitFor(() =>
      expect(mocks.bootstrap).toHaveBeenCalledWith({ venueId: 'venue / 1' }, expect.any(Object)),
    )
  })

  it('rejects a stale venue bootstrap and cannot send into the previous venue', async () => {
    let resolveFirst: ((value: typeof bootstrap) => void) | undefined
    let resolveSecond:
      | ((
          value: typeof bootstrap & {
            venues: Array<{ id: string; name: string }>
            selectedVenueId: string
          },
        ) => void)
      | undefined
    searchParams = new URLSearchParams({ venue: 'venue-1' })
    mocks.bootstrap
      .mockImplementationOnce(
        () =>
          new Promise<typeof bootstrap>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<
            typeof bootstrap & {
              venues: Array<{ id: string; name: string }>
              selectedVenueId: string
            }
          >((resolve) => {
            resolveSecond = resolve
          }),
      )
    const view = render(<ClientTochiWorkspace />)
    await waitFor(() =>
      expect(mocks.bootstrap).toHaveBeenLastCalledWith({ venueId: 'venue-1' }, expect.any(Object)),
    )

    searchParams = new URLSearchParams({ venue: 'venue-2' })
    view.rerender(<ClientTochiWorkspace />)
    expect(screen.queryByRole('button', { name: 'Ask Tochi' })).toBeNull()
    await waitFor(() =>
      expect(mocks.bootstrap).toHaveBeenLastCalledWith({ venueId: 'venue-2' }, expect.any(Object)),
    )
    await act(async () => resolveFirst?.(bootstrap))
    expect(screen.queryByRole('button', { name: 'Ask Tochi' })).toBeNull()

    await act(async () =>
      resolveSecond?.({
        ...bootstrap,
        venues: [
          { id: 'venue-1', name: 'Harbor Museum' },
          { id: 'venue-2', name: 'River Museum' },
        ],
        selectedVenueId: 'venue-2',
      }),
    )
    mocks.send.mockResolvedValue({ id: 'turn-venue-2', answer: 'Current venue only.' })
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Tochi' }))
    fireEvent.change(screen.getByLabelText('Message Tochi'), {
      target: { value: 'What is current?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await screen.findByText('Current venue only.')
    expect(mocks.send).toHaveBeenCalledWith({
      operationId: '11111111-1111-4111-8111-111111111111',
      venueId: 'venue-2',
      message: 'What is current?',
    })
    expect(mocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ venueId: 'venue-1' }))
  })

  it('cannot let a late manual venue selection overwrite a newer route venue', async () => {
    const multiVenueBootstrap = {
      ...bootstrap,
      venues: [
        { id: 'venue-1', name: 'Harbor Museum' },
        { id: 'venue-2', name: 'River Museum' },
        { id: 'venue-3', name: 'Garden Museum' },
      ],
    }
    let resolveManual:
      | ((value: typeof multiVenueBootstrap & { selectedVenueId: string }) => void)
      | undefined
    let resolveRoute:
      | ((value: typeof multiVenueBootstrap & { selectedVenueId: string }) => void)
      | undefined
    searchParams = new URLSearchParams({ venue: 'venue-1' })
    mocks.bootstrap
      .mockResolvedValueOnce(multiVenueBootstrap)
      .mockImplementationOnce(
        () =>
          new Promise<typeof multiVenueBootstrap & { selectedVenueId: string }>((resolve) => {
            resolveManual = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<typeof multiVenueBootstrap & { selectedVenueId: string }>((resolve) => {
            resolveRoute = resolve
          }),
      )
    const view = render(<ClientTochiWorkspace />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Tochi' }))
    fireEvent.change(screen.getByLabelText('Venue context'), { target: { value: 'venue-2' } })
    await waitFor(() =>
      expect(mocks.bootstrap).toHaveBeenLastCalledWith({ venueId: 'venue-2' }, expect.any(Object)),
    )

    searchParams = new URLSearchParams({ venue: 'venue-3' })
    view.rerender(<ClientTochiWorkspace />)
    await waitFor(() =>
      expect(mocks.bootstrap).toHaveBeenLastCalledWith({ venueId: 'venue-3' }, expect.any(Object)),
    )
    await act(async () => resolveRoute?.({ ...multiVenueBootstrap, selectedVenueId: 'venue-3' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Tochi' }))
    expect(await screen.findByText(/Portal guidance for Garden Museum/)).toBeTruthy()

    await act(async () => resolveManual?.({ ...multiVenueBootstrap, selectedVenueId: 'venue-2' }))
    expect(screen.getByText(/Portal guidance for Garden Museum/)).toBeTruthy()
    mocks.send.mockResolvedValue({ id: 'turn-venue-3', answer: 'Garden only.' })
    fireEvent.change(screen.getByLabelText('Message Tochi'), {
      target: { value: 'What is current?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Garden only.')
    expect(mocks.send).toHaveBeenLastCalledWith({
      operationId: '11111111-1111-4111-8111-111111111111',
      venueId: 'venue-3',
      message: 'What is current?',
    })
  })

  it('cannot let a late preference save overwrite a newer route bootstrap', async () => {
    let resolvePreference:
      | ((value: { enabled: boolean; minimized: boolean; revision: number }) => void)
      | undefined
    searchParams = new URLSearchParams({ venue: 'venue-1' })
    mocks.bootstrap.mockResolvedValueOnce(bootstrap).mockResolvedValueOnce({
      ...bootstrap,
      venues: [
        { id: 'venue-1', name: 'Harbor Museum' },
        { id: 'venue-2', name: 'River Museum' },
      ],
      selectedVenueId: 'venue-2',
      preference: { enabled: true, minimized: false, revision: 8 },
    })
    mocks.setPreference.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreference = resolve
        }),
    )
    const view = render(<ClientTochiWorkspace />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Tochi' }))
    fireEvent.click(screen.getByRole('button', { name: 'Minimize Tochi' }))
    await waitFor(() => expect(mocks.setPreference).toHaveBeenCalledOnce())

    searchParams = new URLSearchParams({ venue: 'venue-2' })
    view.rerender(<ClientTochiWorkspace />)
    expect(await screen.findByRole('button', { name: 'Ask Tochi' })).toBeTruthy()
    await act(async () => resolvePreference?.({ enabled: true, minimized: true, revision: 3 }))

    expect(screen.getByRole('button', { name: 'Ask Tochi' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Tochi' })).toBeNull()
  })

  it('does not present the prior bootstrap while the client instance is replaced', async () => {
    let resolveReplacement: ((value: typeof bootstrap) => void) | undefined
    mocks.bootstrap.mockResolvedValueOnce(bootstrap)
    secondTrpcClient.clientAssistant.bootstrap.query.mockImplementationOnce(
      () =>
        new Promise<typeof bootstrap>((resolve) => {
          resolveReplacement = resolve
        }),
    )
    const view = render(<ClientTochiWorkspace />)
    await screen.findByRole('button', { name: 'Ask Tochi' })

    currentClient.value = secondTrpcClient
    view.rerender(<ClientTochiWorkspace />)
    expect(screen.queryByRole('button', { name: 'Ask Tochi' })).toBeNull()
    await waitFor(() =>
      expect(secondTrpcClient.clientAssistant.bootstrap.query).toHaveBeenCalledWith(
        {},
        expect.any(Object),
      ),
    )
    await act(async () => resolveReplacement?.(bootstrap))
    expect(await screen.findByRole('button', { name: 'Ask Tochi' })).toBeTruthy()
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

  it('does not submit the previous venue while a replacement client bootstrap waits', async () => {
    let resolveNext: ((value: typeof bootstrap) => void) | undefined
    mocks.bootstrap.mockResolvedValueOnce(bootstrap)
    secondTrpcClient.clientAssistant.bootstrap.query.mockReturnValueOnce(
      new Promise<typeof bootstrap>((resolve) => {
        resolveNext = resolve
      }),
    )
    const view = render(<ClientTochiPreferenceWorkspace />)
    await screen.findByRole('button', { name: 'Off' })

    currentClient.value = secondTrpcClient
    view.rerender(<ClientTochiPreferenceWorkspace />)
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull()
    expect(secondTrpcClient.clientAssistant.setPreference.mutate).not.toHaveBeenCalled()

    resolveNext?.({ ...bootstrap, selectedVenueId: 'venue-2' })
    await screen.findByRole('button', { name: 'Off' })
    expect(secondTrpcClient.clientAssistant.setPreference.mutate).not.toHaveBeenCalled()
  })

  it('cannot let an old save overwrite the replacement client state', async () => {
    let resolveSave:
      | ((value: { enabled: boolean; minimized: boolean; revision: number }) => void)
      | undefined
    mocks.bootstrap.mockResolvedValueOnce(bootstrap)
    mocks.setPreference.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve
      }),
    )
    secondTrpcClient.clientAssistant.bootstrap.query.mockResolvedValueOnce({
      ...bootstrap,
      selectedVenueId: 'venue-2',
      preference: { enabled: true, minimized: true, revision: 8 },
    })
    const view = render(<ClientTochiPreferenceWorkspace />)
    await screen.findByRole('button', { name: 'Off' })
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))

    currentClient.value = secondTrpcClient
    view.rerender(<ClientTochiPreferenceWorkspace />)
    await screen.findByRole('button', { name: 'On' })
    await act(async () => resolveSave?.({ enabled: false, minimized: false, revision: 3 }))
    expect(screen.getByRole('button', { name: 'On' }).getAttribute('aria-pressed')).toBe('true')
    expect(secondTrpcClient.clientAssistant.setPreference.mutate).not.toHaveBeenCalled()
    secondTrpcClient.clientAssistant.setPreference.mutate.mockResolvedValueOnce({
      enabled: false,
      minimized: true,
      revision: 9,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await screen.findByText('Tochi assistance is off.')
    expect(secondTrpcClient.clientAssistant.setPreference.mutate).toHaveBeenCalledWith({
      venueId: 'venue-2',
      enabled: false,
      minimized: true,
      expectedRevision: 8,
    })
  })

  it('loads and confirms preference saves through StrictMode effect replay', async () => {
    mocks.setPreference.mockResolvedValueOnce({ enabled: false, minimized: false, revision: 3 })
    render(
      <React.StrictMode>
        <ClientTochiPreferenceWorkspace />
      </React.StrictMode>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Off' }))
    expect(await screen.findByText('Tochi assistance is off.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('true')
    expect(mocks.setPreference).toHaveBeenCalledOnce()
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
