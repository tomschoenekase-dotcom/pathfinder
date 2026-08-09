/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  getById: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  client: {
    place: {
      create: { mutate: vi.fn() },
      update: { mutate: vi.fn() },
      delete: { mutate: vi.fn() },
      getById: { query: vi.fn() },
    },
  },
}))

mocks.client.place.create.mutate = mocks.create
mocks.client.place.update.mutate = mocks.update
mocks.client.place.delete.mutate = mocks.remove
mocks.client.place.getById.query = mocks.getById

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}))
vi.mock('../lib/trpc', () => ({ useTRPCClient: () => mocks.client }))

import { PlaceForm } from './PlaceForm'

const venueId = 'cm00000000000000000000001'
const placeId = 'cm00000000000000000000002'

describe('PlaceForm', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('requires deliberate coordinates for a location-aware item, then sends exact values', async () => {
    mocks.create.mockResolvedValueOnce({ id: placeId })
    render(<PlaceForm mode="create" venueId={venueId} venueGuideMode="location_aware" />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Main Gallery' } })
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'exhibit' } })
    expect((screen.getByLabelText('Latitude') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Longitude') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Add guide item' }))

    expect(
      await screen.findByText('Latitude and longitude are required for location-aware venues.'),
    ).toBeTruthy()
    expect(mocks.create).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '41.5' } })
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '-81.7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add guide item' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId,
        name: 'Main Gallery',
        type: 'exhibit',
        lat: 41.5,
        lng: -81.7,
      }),
    )
    expect(mocks.push).toHaveBeenCalledWith(`/venues/${venueId}`)
  })

  it('derives the non-location type and normalizes optional content', async () => {
    mocks.create.mockResolvedValueOnce({ id: placeId })
    render(<PlaceForm mode="create" venueId={venueId} venueGuideMode="non_location" />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Refund policy' } })
    fireEvent.change(screen.getByLabelText('Item type (optional)'), {
      target: { value: 'policy' },
    })
    fireEvent.change(screen.getByLabelText('Short description'), {
      target: { value: '  Ask the front desk.  ' },
    })
    fireEvent.change(screen.getByLabelText('Latitude (optional)'), {
      target: { value: '40.1' },
    })
    fireEvent.change(screen.getByLabelText('Longitude (optional)'), {
      target: { value: '-80.2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add guide item' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId,
        name: 'Refund policy',
        type: 'policy',
        itemType: 'policy',
        shortDescription: 'Ask the front desk.',
        lat: 40.1,
        lng: -80.2,
      }),
    )
  })

  it('maps edit-only null and activity semantics while preserving state on failure', async () => {
    mocks.update.mockRejectedValueOnce(new Error('Guide item changed in another session'))
    render(
      <PlaceForm
        mode="edit"
        venueId={venueId}
        venueGuideMode="non_location"
        placeId={placeId}
        initialValues={{
          id: placeId,
          venueId,
          name: 'FAQ',
          type: 'faq',
          itemType: 'faq',
          shortDescription: 'Original',
          longDescription: '',
          lat: undefined,
          lng: undefined,
          tags: [],
          importanceScore: 0,
          areaName: '',
          hours: '',
          photoUrl: '',
          isActive: false,
        }}
      />,
    )

    fireEvent.change(screen.getByLabelText('Short description'), {
      target: { value: 'Revised answer' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce())
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: placeId,
        type: 'faq',
        itemType: 'faq',
        shortDescription: 'Revised answer',
        photoUrl: null,
        isActive: false,
      }),
    )
    expect(await screen.findByText('Guide item changed in another session')).toBeTruthy()
    expect((screen.getByLabelText('Short description') as HTMLTextAreaElement).value).toBe(
      'Revised answer',
    )
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('does not delete when confirmation is declined', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(
      <PlaceForm
        mode="edit"
        venueId={venueId}
        venueGuideMode="non_location"
        placeId={placeId}
        initialValues={{
          id: placeId,
          venueId,
          name: 'FAQ',
          type: 'faq',
          itemType: 'faq',
          shortDescription: '',
          longDescription: '',
          lat: undefined,
          lng: undefined,
          tags: [],
          importanceScore: 0,
          areaName: '',
          hours: '',
          photoUrl: '',
          isActive: true,
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete guide item' }))

    expect(confirm).toHaveBeenCalledWith('Delete this guide item? This cannot be undone.')
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
  })
})
