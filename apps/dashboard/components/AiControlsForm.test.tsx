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

const venueId = 'clxvenue00000000000000001'
const places = [{ id: 'clxplace00000000000000001', name: 'River Gallery' }]
const initialConfig = {
  aiGuideNotes: 'Initial notes',
  aiFeaturedPlaceId: null,
  aiTone: 'FRIENDLY',
  aiGuideName: 'Path Guide',
}

describe('AiControlsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateAiConfig.mockResolvedValue({})
  })

  afterEach(cleanup)

  it('submits the exact normalized venue payload and exposes selected tone state', async () => {
    render(
      <AiControlsForm
        initialVenueId={venueId}
        initialConfig={{ ...initialConfig, aiTone: 'LEGACY', aiFeaturedPlaceId: 'stale' }}
        initialPlaces={places}
      />,
    )

    expect(screen.getByRole('button', { name: /^Friendly/u }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(screen.getByLabelText<HTMLSelectElement>('Featured guide item').value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: /^Playful/u }))
    fireEvent.change(screen.getByLabelText('Guide name'), { target: { value: '  Pip  ' } })
    fireEvent.change(screen.getByLabelText('Guide notes'), { target: { value: '   ' } })
    fireEvent.change(screen.getByLabelText('Featured guide item'), {
      target: { value: places[0]!.id },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save AI configuration' }))

    await waitFor(() =>
      expect(mocks.updateAiConfig).toHaveBeenCalledWith({
        venueId,
        aiTone: 'PLAYFUL',
        aiGuideName: 'Pip',
        aiGuideNotes: null,
        aiFeaturedPlaceId: places[0]!.id,
      }),
    )
    expect(screen.getByRole('status').textContent).toContain('AI configuration saved')
    expect(screen.getByLabelText<HTMLInputElement>('Guide name').value).toBe('Pip')
    expect(screen.getByLabelText<HTMLTextAreaElement>('Guide notes').value).toBe('')
  })

  it('synchronously fences duplicate saves and locks every editable control while pending', async () => {
    let resolveSave!: () => void
    mocks.updateAiConfig.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveSave = resolve)),
    )
    render(
      <AiControlsForm
        initialVenueId={venueId}
        initialConfig={initialConfig}
        initialPlaces={places}
      />,
    )

    const form = screen.getByRole('button', { name: 'Save AI configuration' }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)

    const saving = await screen.findByRole('button', { name: 'Saving...' })
    expect(mocks.updateAiConfig).toHaveBeenCalledOnce()
    expect((saving as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /^Friendly/u }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByLabelText('Featured guide item') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText('Guide name') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Guide notes') as HTMLTextAreaElement).disabled).toBe(true)

    await act(async () => resolveSave())
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
  })

  it('retains failed input, reports an alert, and clears stale feedback on edit', async () => {
    mocks.updateAiConfig.mockRejectedValueOnce(new Error('Configuration conflict'))
    render(
      <AiControlsForm
        initialVenueId={venueId}
        initialConfig={initialConfig}
        initialPlaces={places}
      />,
    )

    fireEvent.change(screen.getByLabelText('Guide notes'), { target: { value: 'Keep this draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save AI configuration' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Configuration conflict')
    expect(screen.getByLabelText<HTMLTextAreaElement>('Guide notes').value).toBe('Keep this draft')
    fireEvent.change(screen.getByLabelText('Guide notes'), {
      target: { value: 'Revised draft' },
    })
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Save AI configuration' }))
    expect(await screen.findByRole('status')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Professional/u }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('degrades gracefully without guide items and submits an explicit null selection', async () => {
    render(
      <AiControlsForm initialVenueId={venueId} initialConfig={initialConfig} initialPlaces={[]} />,
    )

    expect((screen.getByLabelText('Featured guide item') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByText(/Add guide items/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save AI configuration' }))

    await waitFor(() =>
      expect(mocks.updateAiConfig).toHaveBeenCalledWith(
        expect.objectContaining({ venueId, aiFeaturedPlaceId: null }),
      ),
    )
  })
})
