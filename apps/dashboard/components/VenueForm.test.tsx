/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  deleteVenue: vi.fn(),
  getById: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  client: {
    venue: {
      create: { mutate: vi.fn() },
      update: { mutate: vi.fn() },
      delete: { mutate: vi.fn() },
      getById: { query: vi.fn() },
    },
  },
}))

mocks.client.venue.create.mutate = mocks.create
mocks.client.venue.update.mutate = mocks.update
mocks.client.venue.delete.mutate = mocks.deleteVenue
mocks.client.venue.getById.query = mocks.getById

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}))

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => mocks.client,
}))

import { VenueForm } from './VenueForm'

const venueRevision = '2026-08-09T18:00:00.000Z'
const editVenueValues = {
  name: 'Harbor Museum',
  slug: 'harbor-museum',
  description: '',
  guideNotes: '',
  category: 'museum',
  guideMode: 'location_aware' as const,
  defaultCenterLat: 41.5,
  defaultCenterLng: -81.7,
  updatedAt: venueRevision,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('VenueForm', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('creates a non-location venue with trimmed optional fields and no coordinates', async () => {
    mocks.create.mockResolvedValueOnce({ id: 'venue-created' })
    render(<VenueForm mode="create" />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'City Services' } })
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: ' city-services ' } })
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: ' service guide ' } })
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: ' Public information ' },
    })
    fireEvent.change(screen.getByLabelText('Guide notes'), {
      target: { value: ' Answer concise questions. ' },
    })
    fireEvent.click(screen.getByRole('radio', { name: /^No/ }))

    expect(screen.queryByLabelText('Default center latitude')).toBeNull()
    expect(screen.queryByLabelText('Default center longitude')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(mocks.create).toHaveBeenCalledWith({
      name: 'City Services',
      slug: 'city-services',
      description: 'Public information',
      guideNotes: 'Answer concise questions.',
      category: 'service guide',
      guideMode: 'non_location',
      defaultCenterLat: undefined,
      defaultCenterLng: undefined,
    })
    expect(mocks.push).toHaveBeenCalledWith('/venues/venue-created')
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('loads an edit target and submits exact location-aware coordinates without slug', async () => {
    mocks.getById.mockResolvedValueOnce({
      name: 'Harbor Museum',
      slug: 'harbor-museum',
      description: null,
      guideNotes: null,
      category: 'museum',
      guideMode: 'location_aware',
      defaultCenterLat: 41.5,
      defaultCenterLng: -81.7,
      updatedAt: new Date(venueRevision),
    })
    mocks.update.mockResolvedValueOnce({ id: 'venue-1' })
    render(<VenueForm mode="edit" venueId="venue-1" />)

    expect(screen.getByText('Loading venue...')).toBeTruthy()
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement
    expect(name.value).toBe('Harbor Museum')
    expect(screen.queryByLabelText('Slug')).toBeNull()
    fireEvent.change(screen.getByLabelText('Default center latitude'), {
      target: { value: '42.25' },
    })
    fireEvent.change(screen.getByLabelText('Default center longitude'), {
      target: { value: '-82.5' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce())
    expect(mocks.update).toHaveBeenCalledWith({
      id: 'venue-1',
      expectedUpdatedAt: new Date(venueRevision),
      name: 'Harbor Museum',
      description: undefined,
      guideNotes: undefined,
      category: 'museum',
      guideMode: 'location_aware',
      defaultCenterLat: 42.25,
      defaultCenterLng: -82.5,
    })
    expect(mocks.push).toHaveBeenCalledWith('/venues/venue-1')
  })

  it('preserves form state and navigation on a failed mutation', async () => {
    mocks.create.mockRejectedValueOnce(new Error('Venue slug is already in use'))
    render(<VenueForm mode="create" />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Duplicate Venue' } })
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'duplicate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create venue' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(await screen.findByText('Venue slug is already in use')).toBeTruthy()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Duplicate Venue')
    expect((screen.getByLabelText('Slug') as HTMLInputElement).value).toBe('duplicate')
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('fences duplicate saves, locks all controls, and permits retry after transport failure', async () => {
    const pendingUpdate = deferred<{ id: string }>()
    mocks.update.mockReturnValueOnce(pendingUpdate.promise)
    render(<VenueForm mode="edit" venueId="venue-1" initialValues={{ ...editVenueValues }} />)

    const nameInput = screen.getByLabelText('Name') as HTMLInputElement
    const saveButton = screen.getByRole('button', { name: 'Save changes' })
    const form = saveButton.closest('form') as HTMLFormElement
    fireEvent.change(nameInput, { target: { value: 'Revised Harbor Museum' } })
    fireEvent.submit(form)
    fireEvent.submit(form)

    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce())
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUpdatedAt: new Date(venueRevision) }),
    )
    expect(form.getAttribute('aria-busy')).toBe('true')
    expect(nameInput.disabled).toBe(true)
    expect((screen.getByLabelText('Category') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('radio', { name: /^Yes/ }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('radio', { name: /^No/ }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('Guide notes') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('Default center latitude') as HTMLInputElement).disabled).toBe(
      true,
    )
    expect((screen.getByLabelText('Default center longitude') as HTMLInputElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: 'Saving...' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(
      (screen.getByRole('button', { name: 'Delete venue' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    await act(async () => pendingUpdate.reject(new Error('Network unavailable')))
    expect((await screen.findByRole('alert')).textContent).toContain('Network unavailable')
    expect(nameInput.value).toBe('Revised Harbor Museum')
    expect(form.getAttribute('aria-busy')).toBe('false')

    mocks.update.mockResolvedValueOnce({ id: 'venue-1' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2))
    expect(mocks.push).toHaveBeenCalledWith('/venues/venue-1')
  })

  it('retains a stale edit and surfaces the server conflict without navigating', async () => {
    mocks.update.mockRejectedValueOnce(
      new Error('Venue changed in another session. Refresh and try again.'),
    )
    render(<VenueForm mode="edit" venueId="venue-1" initialValues={{ ...editVenueValues }} />)

    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'My unsaved revision' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Venue changed in another session. Refresh and try again.',
    )
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
      'My unsaved revision',
    )
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('does not navigate when a venue save completes after unmount', async () => {
    const pendingUpdate = deferred<{ id: string }>()
    mocks.update.mockReturnValueOnce(pendingUpdate.promise)
    const view = render(
      <VenueForm mode="edit" venueId="venue-1" initialValues={{ ...editVenueValues }} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce())
    view.unmount()
    await act(async () => pendingUpdate.resolve({ id: 'venue-1' }))

    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('fences duplicate delete/save overlap and ignores deletion completion after unmount', async () => {
    const pendingDelete = deferred<{ id: string }>()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.deleteVenue.mockReturnValueOnce(pendingDelete.promise)
    const view = render(
      <VenueForm mode="edit" venueId="venue-1" initialValues={{ ...editVenueValues }} />,
    )

    const deleteButton = screen.getByRole('button', { name: 'Delete venue' })
    fireEvent.click(deleteButton)
    fireEvent.click(deleteButton)
    fireEvent.submit(deleteButton.closest('form') as HTMLFormElement)

    await waitFor(() => expect(mocks.deleteVenue).toHaveBeenCalledOnce())
    expect(mocks.update).not.toHaveBeenCalled()
    expect(
      (screen.getByRole('button', { name: 'Deleting...' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    view.unmount()
    await act(async () => pendingDelete.resolve({ id: 'venue-1' }))

    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('clears hidden center coordinates when an edited venue becomes non-location', async () => {
    mocks.update.mockResolvedValueOnce({ id: 'venue-1' })
    render(
      <VenueForm
        mode="edit"
        venueId="venue-1"
        initialValues={{
          name: 'Harbor Museum',
          slug: 'harbor-museum',
          description: '',
          guideNotes: '',
          category: 'museum',
          guideMode: 'location_aware',
          defaultCenterLat: 41.5,
          defaultCenterLng: -81.7,
          updatedAt: venueRevision,
        }}
      />,
    )

    fireEvent.click(screen.getByRole('radio', { name: /^No/ }))
    expect(screen.queryByLabelText('Default center latitude')).toBeNull()
    expect(screen.queryByLabelText('Default center longitude')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce())
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'venue-1',
        guideMode: 'non_location',
        defaultCenterLat: undefined,
        defaultCenterLng: undefined,
      }),
    )
  })

  it('requires delete confirmation and retains the edit page after delete failure', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.deleteVenue.mockRejectedValueOnce(new Error('Remove all guide items first'))
    render(
      <VenueForm
        mode="edit"
        venueId="venue-1"
        initialValues={{
          name: 'Museum',
          slug: 'museum',
          description: '',
          guideNotes: '',
          category: '',
          guideMode: 'non_location',
          defaultCenterLat: undefined,
          defaultCenterLng: undefined,
          updatedAt: venueRevision,
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete venue' }))

    await waitFor(() =>
      expect(mocks.deleteVenue).toHaveBeenCalledWith({
        id: 'venue-1',
        expectedUpdatedAt: new Date(venueRevision),
      }),
    )
    expect(confirm).toHaveBeenCalledWith('Delete this venue? This cannot be undone.')
    expect(await screen.findByText('Remove all guide items first')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete venue' })).toBeTruthy()
    expect(mocks.push).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
})
