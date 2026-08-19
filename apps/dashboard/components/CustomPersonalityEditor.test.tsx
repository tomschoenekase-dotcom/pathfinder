/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }))
const client = vi.hoisted(() => ({
  venue: {
    createPersonalityProfile: { mutate: mocks.create },
    updatePersonalityProfile: { mutate: mocks.update },
  },
}))
vi.mock('../lib/trpc', () => ({ useTRPCClient: () => client }))

import { CustomPersonalityEditor } from './CustomPersonalityEditor'

describe('CustomPersonalityEditor', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('creates a bounded profile and selects it without claiming platform rules changed', async () => {
    const onSaved = vi.fn()
    const onSelect = vi.fn()
    mocks.create.mockResolvedValue({
      id: 'profile-1',
      venueId: 'venue-1',
      name: 'My Venue Bot style',
      bounds: { warmth: 0.7, brevity: 0.7, energy: 0.5, formality: 0.5 },
      revision: 1,
      updatedAt: '2026-08-19T12:00:00.000Z',
    })
    render(
      <CustomPersonalityEditor
        venueId="venue-1"
        profiles={[]}
        selectedProfileId={null}
        disabled={false}
        onSaved={onSaved}
        onSelect={onSelect}
      />,
    )
    expect(
      screen.getByText(/never change Venue Bot's factual, privacy, or safety rules/u),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save custom profile' }))
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        venueId: 'venue-1',
        profile: {
          name: 'My Venue Bot style',
          bounds: { warmth: 0.7, brevity: 0.7, energy: 0.5, formality: 0.5 },
        },
      }),
    )
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'profile-1' }))
    expect(onSelect).toHaveBeenCalledWith('profile-1')
  })
})
