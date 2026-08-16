/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  tenantMutate: vi.fn(),
  adminMutate: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    venue: { setAvailability: { mutate: mocks.tenantMutate } },
    admin: { setVenueAvailability: { mutate: mocks.adminMutate } },
  }),
}))

import { VenueAvailabilityControl } from './VenueAvailabilityControl'

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

const initialState = {
  isActive: true,
  updatedAt: '2026-08-08T20:00:00.000Z',
}

describe('VenueAvailabilityControl', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders the server revision in a deterministic UTC format', () => {
    render(
      <VenueAvailabilityControl
        scope="tenant"
        venueName="Harbor Museum"
        venueId="venue_1"
        initialState={initialState}
      />,
    )

    const revision = screen.getByText('Aug 8, 2026, 8:00 PM UTC')
    expect(revision.getAttribute('datetime')).toBe(initialState.updatedAt)
  })

  it('requires confirmation and submits the exact tenant revision and trimmed reason', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.tenantMutate.mockResolvedValueOnce({
      id: 'venue_1',
      isActive: false,
      updatedAt: new Date('2026-08-08T20:01:00.000Z'),
      replayed: false,
    })
    render(
      <VenueAvailabilityControl
        scope="tenant"
        venueName="Harbor Museum"
        venueId="venue_1"
        initialState={initialState}
      />,
    )

    const button = screen.getByRole('button', { name: 'Pause this venue' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Internal reason'), {
      target: { value: '  Guest service incident  ' },
    })
    fireEvent.click(button)

    await waitFor(() => expect(mocks.tenantMutate).toHaveBeenCalledOnce())
    expect(confirm).toHaveBeenCalledWith(
      'Pause guest access and venue-scoped processing for Harbor Museum?',
    )
    expect(mocks.tenantMutate).toHaveBeenCalledWith({
      venueId: 'venue_1',
      enabled: false,
      expectedUpdatedAt: new Date(initialState.updatedAt),
      reason: 'Guest service incident',
    })
    expect(await screen.findByText('Venue access and processing paused.')).toBeTruthy()
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
    confirm.mockRestore()
  })

  it('uses the platform-admin endpoint with the exact tenant boundary', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.adminMutate.mockResolvedValueOnce({
      id: 'venue_1',
      isActive: true,
      updatedAt: new Date('2026-08-08T20:02:00.000Z'),
      replayed: false,
    })
    render(
      <VenueAvailabilityControl
        scope="admin"
        tenantId="tenant_1"
        venueName="Harbor Museum"
        venueId="venue_1"
        initialState={{ ...initialState, isActive: false }}
      />,
    )

    fireEvent.change(screen.getByLabelText('Internal reason'), {
      target: { value: 'Incident resolved' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Resume this venue' }))

    await waitFor(() => expect(mocks.adminMutate).toHaveBeenCalledOnce())
    expect(mocks.adminMutate).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      enabled: true,
      expectedUpdatedAt: new Date(initialState.updatedAt),
      reason: 'Incident resolved',
    })
    expect(mocks.tenantMutate).not.toHaveBeenCalled()
  })

  it('does not mutate when confirmation is declined', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(
      <VenueAvailabilityControl
        scope="tenant"
        venueName="Harbor Museum"
        venueId="venue_1"
        initialState={initialState}
      />,
    )
    fireEvent.change(screen.getByLabelText('Internal reason'), { target: { value: 'Investigate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pause this venue' }))
    expect(mocks.tenantMutate).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('confirms once, admits one same-tick action, locks while pending, and unlocks on success', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = deferred<{
      id: string
      isActive: boolean
      updatedAt: Date
      replayed: boolean
    }>()
    mocks.tenantMutate.mockReturnValueOnce(pending.promise)
    render(
      <VenueAvailabilityControl
        scope="tenant"
        venueName="Harbor Museum"
        venueId="venue_1"
        initialState={initialState}
      />,
    )
    const reason = screen.getByLabelText('Internal reason') as HTMLTextAreaElement
    fireEvent.change(reason, { target: { value: 'Guest safety incident' } })
    const pause = screen.getByRole('button', { name: 'Pause this venue' })

    act(() => {
      pause.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      pause.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(confirm).toHaveBeenCalledOnce()
    expect(mocks.tenantMutate).toHaveBeenCalledOnce()
    const section = screen.getByRole('heading', { name: 'Venue availability' }).closest('section')
    expect(section?.getAttribute('aria-busy')).toBe('true')
    expect(reason.disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Saving...' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    pending.resolve({
      id: 'venue_1',
      isActive: false,
      updatedAt: new Date('2026-08-08T20:01:00.000Z'),
      replayed: false,
    })
    expect((await screen.findByRole('status')).textContent).toContain(
      'Venue access and processing paused.',
    )
    expect(section?.getAttribute('aria-busy')).toBe('false')
    expect((screen.getByLabelText('Internal reason') as HTMLTextAreaElement).disabled).toBe(false)
    expect((screen.getByLabelText('Internal reason') as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it.each([
    {
      error: codedError('CONFLICT', 'A deliberately opaque production error.'),
      expected: 'changed in another session',
    },
    {
      error: new Error('Venue availability changed; this message only resembles a conflict.'),
      expected: 'could not be confirmed',
    },
  ])('uses safe structured venue failure guidance: $expected', async ({ error, expected }) => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.tenantMutate.mockRejectedValueOnce(error)
    render(
      <VenueAvailabilityControl
        scope="tenant"
        venueName="Harbor Museum"
        venueId="venue_1"
        initialState={initialState}
      />,
    )
    fireEvent.change(screen.getByLabelText('Internal reason'), {
      target: { value: 'Investigate venue state' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pause this venue' }))

    expect((await screen.findByRole('alert')).textContent).toContain(expected)
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect((screen.getByLabelText('Internal reason') as HTMLTextAreaElement).value).toBe(
      'Investigate venue state',
    )
  })

  it('suppresses late venue state and router refresh after unmount', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = deferred<{
      id: string
      isActive: boolean
      updatedAt: Date
      replayed: boolean
    }>()
    mocks.tenantMutate.mockReturnValueOnce(pending.promise)
    const view = render(
      <VenueAvailabilityControl
        scope="tenant"
        venueName="Harbor Museum"
        venueId="venue_1"
        initialState={initialState}
      />,
    )
    fireEvent.change(screen.getByLabelText('Internal reason'), { target: { value: 'Outage' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pause this venue' }))
    await waitFor(() => expect(mocks.tenantMutate).toHaveBeenCalledOnce())
    view.unmount()

    pending.resolve({
      id: 'venue_1',
      isActive: false,
      updatedAt: new Date('2026-08-08T20:01:00.000Z'),
      replayed: false,
    })
    await act(async () => pending.promise)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('ignores an old venue completion and clears draft and feedback when venue props change', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = deferred<{
      id: string
      isActive: boolean
      updatedAt: Date
      replayed: boolean
    }>()
    mocks.tenantMutate.mockReturnValueOnce(pending.promise)
    const view = render(
      <VenueAvailabilityControl
        scope="tenant"
        venueName="First Museum"
        venueId="venue_1"
        initialState={initialState}
      />,
    )
    fireEvent.change(screen.getByLabelText('Internal reason'), {
      target: { value: 'First venue draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pause this venue' }))
    await waitFor(() => expect(mocks.tenantMutate).toHaveBeenCalledOnce())

    view.rerender(
      <VenueAvailabilityControl
        scope="tenant"
        venueName="Second Museum"
        venueId="venue_2"
        initialState={{ isActive: false, updatedAt: '2026-08-08T20:10:00.000Z' }}
      />,
    )
    expect((screen.getByLabelText('Internal reason') as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()

    pending.resolve({
      id: 'venue_1',
      isActive: true,
      updatedAt: new Date('2026-08-08T20:11:00.000Z'),
      replayed: false,
    })
    await act(async () => pending.promise)
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('invalidates an old admin completion when the tenant scope changes for the same venue', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = deferred<{
      id: string
      isActive: boolean
      updatedAt: Date
      replayed: boolean
    }>()
    mocks.adminMutate.mockReturnValueOnce(pending.promise)
    const view = render(
      <VenueAvailabilityControl
        scope="admin"
        tenantId="tenant_1"
        venueName="Harbor Museum"
        venueId="venue_1"
        initialState={initialState}
      />,
    )
    fireEvent.change(screen.getByLabelText('Internal reason'), { target: { value: 'Old tenant' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pause this venue' }))
    await waitFor(() => expect(mocks.adminMutate).toHaveBeenCalledOnce())

    view.rerender(
      <VenueAvailabilityControl
        scope="admin"
        tenantId="tenant_2"
        venueName="Harbor Museum"
        venueId="venue_1"
        initialState={initialState}
      />,
    )
    pending.resolve({
      id: 'venue_1',
      isActive: false,
      updatedAt: new Date('2026-08-08T20:01:00.000Z'),
      replayed: false,
    })
    await act(async () => pending.promise)

    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
