/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdminCreateClientForm } from './AdminCreateClientForm'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  uuid: vi.fn(() => '123e4567-e89b-42d3-a456-426614174000'),
  searchParams: new URLSearchParams(),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  useSearchParams: () => mocks.searchParams,
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      createClientAndVenue: { mutate: mocks.create },
    },
  }),
}))
vi.mock('../../lib/browser-uuid', () => ({ browserUuid: mocks.uuid }))

describe('AdminCreateClientForm', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    mocks.searchParams = new URLSearchParams()
  })

  it('synchronously fences same-tick duplicate provider-backed creation', () => {
    mocks.create.mockImplementation(() => new Promise(() => undefined))
    render(<AdminCreateClientForm />)
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Northstar' } })
    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'Lobby' } })
    fireEvent.change(screen.getByLabelText('Primary client contact'), {
      target: { value: 'owner@example.com' },
    })
    const form = screen.getByRole('button', { name: /Create client/ }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: '123e4567-e89b-42d3-a456-426614174000' }),
    )
    expect(form.getAttribute('aria-busy')).toBe('true')
  })

  it('announces a failed creation and returns the form to an operable state', async () => {
    mocks.create.mockRejectedValueOnce(new Error('Workspace creation failed'))
    render(<AdminCreateClientForm />)
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Northstar' } })
    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'Lobby' } })
    fireEvent.change(screen.getByLabelText('Primary client contact'), {
      target: { value: 'owner@example.com' },
    })
    const form = screen.getByRole('button', { name: /Create client/ }).closest('form')!
    fireEvent.submit(form)
    expect((await screen.findByRole('alert')).textContent).toBe('Workspace creation failed')
    await waitFor(() => expect(form.getAttribute('aria-busy')).toBe('false'))
    expect(
      (screen.getByRole('button', { name: /Create client/ }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('creates the client, venue, and primary-contact invitation as one operator flow', async () => {
    mocks.create.mockResolvedValue({
      tenant: { id: 'tenant_1' },
      venue: { id: 'venue / 1' },
      invitation: { id: 'invite_1', replayed: false },
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))
    render(<AdminCreateClientForm />)
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Northstar' } })
    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'Lobby' } })
    fireEvent.change(screen.getByLabelText('Primary client contact'), {
      target: { value: 'owner@example.com' },
    })
    fireEvent.submit(screen.getByRole('button', { name: /Create client/ }).closest('form')!)

    await vi.waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          primaryContact: { emailAddress: 'owner@example.com', role: 'org:admin' },
        }),
      ),
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith('/venues/venue%20%2F%201/onboarding'),
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
    fetchMock.mockRestore()
  })

  it('prefills and permanently links a converted prospect after retry-safe client creation', async () => {
    mocks.searchParams = new URLSearchParams({
      prospectId: 'prospect_1',
      prospectVenueId: 'prospect_venue_1',
      clientName: 'Northstar Arts',
      venueName: 'Northstar Hall',
      primaryContactEmail: 'owner@northstar.example',
    })
    mocks.create.mockResolvedValue({
      tenant: { id: 'tenant_1' },
      venue: { id: 'venue_1' },
      invitation: { id: 'invite_1', replayed: false },
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))

    render(<AdminCreateClientForm />)
    expect((screen.getByLabelText('Client name') as HTMLInputElement).value).toBe('Northstar Arts')
    expect(screen.getByText(/retain a permanent link/i)).toBeTruthy()
    fireEvent.submit(screen.getByRole('button', { name: /Create client/ }).closest('form')!)

    await vi.waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: '123e4567-e89b-42d3-a456-426614174000',
          prospectConversion: {
            organizationId: 'prospect_1',
            prospectVenueId: 'prospect_venue_1',
          },
        }),
      ),
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    fetchMock.mockRestore()
  })

  it('does not navigate when the audited client-view transition fails', async () => {
    mocks.create.mockResolvedValue({
      tenant: { id: 'tenant_1' },
      venue: { id: 'venue_1' },
      invitation: { id: 'invite_1', replayed: false },
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 503 }))
    render(<AdminCreateClientForm />)
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Northstar' } })
    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'Lobby' } })
    fireEvent.change(screen.getByLabelText('Primary client contact'), {
      target: { value: 'owner@example.com' },
    })

    fireEvent.submit(screen.getByRole('button', { name: /Create client/ }).closest('form')!)

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Admin view could not be changed. Please try again.',
    )
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(
      (screen.getByRole('button', { name: /Create client/ }) as HTMLButtonElement).disabled,
    ).toBe(false)
    fetchMock.mockRestore()
  })
})
