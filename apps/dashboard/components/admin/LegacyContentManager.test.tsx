/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  createPlace: vi.fn(),
  updatePlace: vi.fn(),
  retirePlace: vi.fn(),
  createKnowledge: vi.fn(),
  updateKnowledge: vi.fn(),
  retireKnowledge: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      createLegacyPlace: { mutate: mocks.createPlace },
      updateLegacyPlace: { mutate: mocks.updatePlace },
      retireLegacyPlace: { mutate: mocks.retirePlace },
      createLegacyKnowledge: { mutate: mocks.createKnowledge },
      updateLegacyKnowledge: { mutate: mocks.updateKnowledge },
      retireLegacyKnowledge: { mutate: mocks.retireKnowledge },
    },
  }),
}))

import { LegacyContentManager } from './LegacyContentManager'

const revision = new Date('2026-08-11T14:30:00.000Z')
const place = {
  id: 'place_1',
  venueId: 'venue_1',
  name: 'North Hall',
  type: 'room',
  shortDescription: 'Original description',
  longDescription: null,
  tags: ['indoors'],
  importanceScore: 20,
  isActive: true,
  updatedAt: revision,
}
const entry = {
  id: 'knowledge_1',
  venueId: 'venue_1',
  title: 'Bag policy',
  category: 'Policy',
  content: 'Small bags are allowed.',
  isEnabled: true,
  updatedAt: revision,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('LegacyContentManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createPlace.mockResolvedValue({})
    mocks.updatePlace.mockResolvedValue({})
    mocks.retirePlace.mockResolvedValue({})
    mocks.createKnowledge.mockResolvedValue({})
    mocks.updateKnowledge.mockResolvedValue({})
    mocks.retireKnowledge.mockResolvedValue({})
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('sends exact tenant, venue and CAS scope while retaining edits on conflict', async () => {
    mocks.updatePlace.mockRejectedValueOnce(new Error('Content changed after this page loaded'))
    render(
      <LegacyContentManager
        tenantId="tenant_1"
        venueId="venue_1"
        places={[place]}
        knowledgeEntries={[entry]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit Place North Hall' }))
    const form = screen.getByRole('button', { name: 'Save Place changes' }).closest('form')!
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'North Gallery' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save Place changes' }))

    await waitFor(() => expect(mocks.updatePlace).toHaveBeenCalledOnce())
    expect(mocks.updatePlace).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        id: 'place_1',
        expectedUpdatedAt: revision,
        fields: expect.objectContaining({ name: 'North Gallery' }),
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain(
      'entered values are still here',
    )
    expect(within(form).getByLabelText<HTMLInputElement>('Name').value).toBe('North Gallery')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('soft-retires knowledge with exact scope and revision after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <LegacyContentManager
        tenantId="tenant_1"
        venueId="venue_1"
        places={[place]}
        knowledgeEntries={[entry]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retire Knowledge Bag policy' }))
    await waitFor(() =>
      expect(mocks.retireKnowledge).toHaveBeenCalledWith({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        id: 'knowledge_1',
        expectedUpdatedAt: revision,
      }),
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('synchronously fences same-tick duplicate Place creation before busy state renders', async () => {
    const pending = deferred<Record<string, never>>()
    mocks.createPlace.mockReturnValueOnce(pending.promise)
    render(
      <LegacyContentManager
        tenantId="tenant_1"
        venueId="venue_1"
        places={[]}
        knowledgeEntries={[]}
      />,
    )
    const form = screen.getByRole('button', { name: 'Create Place' }).closest('form')!
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Gallery' } })
    fireEvent.change(within(form).getByLabelText('Type'), { target: { value: 'room' } })

    fireEvent.submit(form)
    fireEvent.submit(form)

    await waitFor(() => expect(mocks.createPlace).toHaveBeenCalledOnce())
    await act(async () => pending.resolve({}))
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
  })
})
