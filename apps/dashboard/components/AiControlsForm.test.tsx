/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ updateAiConfig: vi.fn() }))

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({ venue: { updateAiConfig: { mutate: mocks.updateAiConfig } } }),
}))

import { AiControlsForm } from './AiControlsForm'

const config = {
  aiGuideNotes: 'Hidden operator note',
  aiFeaturedPlaceId: 'place_1',
  aiTone: 'FRIENDLY',
  tonePreset: 'friendly',
  tonePresetVersion: 1,
  aiGuideName: 'Pip',
  updatedAt: new Date('2026-08-11T14:30:00.000Z'),
}

describe('AiControlsForm client tone control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateAiConfig.mockResolvedValue({ updatedAt: new Date('2026-08-11T14:31:00.000Z') })
  })
  afterEach(cleanup)

  it('shows all four understandable presets and writes only the client-owned preference', async () => {
    render(<AiControlsForm initialVenueId="venue_1" initialConfig={config} />)

    expect(screen.getByRole('button', { name: /^Friendly/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Concise/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Enthusiastic/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Informative/ })).toBeTruthy()
    expect(screen.queryByLabelText('Guide notes')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Concise/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save tone' }))

    await waitFor(() =>
      expect(mocks.updateAiConfig).toHaveBeenCalledWith({
        venueId: 'venue_1',
        expectedUpdatedAt: config.updatedAt,
        tonePreset: 'concise',
      }),
    )
    expect(screen.getByRole('status').textContent).toContain('Tone saved')
  })

  it('maps a legacy value to its effective preset', () => {
    render(
      <AiControlsForm
        initialVenueId="venue_1"
        initialConfig={{ ...config, tonePreset: null, tonePresetVersion: null, aiTone: 'PLAYFUL' }}
      />,
    )

    expect(screen.getByRole('button', { name: /^Enthusiastic/ }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('fences duplicate saves and reports failures honestly', async () => {
    let reject!: (reason: Error) => void
    mocks.updateAiConfig.mockImplementationOnce(
      () => new Promise((_, rejectPromise) => (reject = rejectPromise)),
    )
    render(<AiControlsForm initialVenueId="venue_1" initialConfig={config} />)

    const form = screen.getByRole('button', { name: 'Save tone' }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(mocks.updateAiConfig).toHaveBeenCalledOnce()
    expect(
      (screen.getByRole('button', { name: 'Saving tone…' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await act(async () => reject(new Error('Could not save this preference')))
    expect(screen.getByRole('alert').textContent).toContain('Could not save')
  })
})
