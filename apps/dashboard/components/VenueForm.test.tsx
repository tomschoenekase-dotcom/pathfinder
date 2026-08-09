/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

describe('VenueForm', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

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
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete venue' }))

    await waitFor(() => expect(mocks.deleteVenue).toHaveBeenCalledWith({ id: 'venue-1' }))
    expect(confirm).toHaveBeenCalledWith('Delete this venue? This cannot be undone.')
    expect(await screen.findByText('Remove all guide items first')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete venue' })).toBeTruthy()
    expect(mocks.push).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
})
