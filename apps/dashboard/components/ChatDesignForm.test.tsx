/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ updateChatDesign: vi.fn() }))

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({ venue: { updateChatDesign: { mutate: mocks.updateChatDesign } } }),
}))

import { ChatDesignForm } from './ChatDesignForm'

const venues = [
  {
    id: 'clxvenue00000000000000001',
    name: 'Science Museum',
    slug: 'science-museum',
    chatTheme: 'forest',
    chatAccentColor: null,
    chatFont: 'inter',
    updatedAt: new Date('2026-08-11T14:30:00.000Z'),
  },
  {
    id: 'clxvenue00000000000000002',
    name: 'History Center',
    slug: 'history-center',
    chatTheme: 'dark',
    chatAccentColor: '#D4607A',
    chatFont: 'playfair',
    updatedAt: new Date('2026-08-11T14:30:00.000Z'),
  },
]

describe('ChatDesignForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateChatDesign.mockResolvedValue({ updatedAt: new Date('2026-08-11T14:31:00.000Z') })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('submits an exact venue-scoped design payload and exposes selected states', async () => {
    render(<ChatDesignForm venues={venues} />)

    expect(screen.getByRole('button', { name: 'Forest' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Inter' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Use dark mode' }).getAttribute('aria-checked')).toBe(
      'false',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sunset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Poppins' }))
    fireEvent.change(screen.getByLabelText('Custom accent colour'), {
      target: { value: '#ABCDEF' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))

    await waitFor(() =>
      expect(mocks.updateChatDesign).toHaveBeenCalledWith({
        venueId: venues[0]!.id,
        expectedUpdatedAt: venues[0]!.updatedAt,
        chatTheme: 'sunset',
        chatAccentColor: '#ABCDEF',
        chatFont: 'poppins',
      }),
    )
    expect((await screen.findByRole('status')).textContent).toContain('Design saved')
  })

  it('rejects a non-empty invalid accent without clearing the stored override', async () => {
    render(<ChatDesignForm venues={venues} />)

    fireEvent.change(screen.getByLabelText('Custom accent colour'), {
      target: { value: 'blue' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))

    expect((await screen.findByRole('alert')).textContent).toContain('six-digit hex colour')
    expect(mocks.updateChatDesign).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Custom accent colour').getAttribute('aria-invalid')).toBe('true')
    expect(
      screen.getByLabelText('Custom accent colour').getAttribute('aria-describedby'),
    ).toContain('accent-color-error')

    fireEvent.change(screen.getByLabelText('Custom accent colour'), { target: { value: '' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))
    await waitFor(() =>
      expect(mocks.updateChatDesign).toHaveBeenCalledWith(
        expect.objectContaining({ chatAccentColor: null }),
      ),
    )
  })

  it('fences duplicate writes and locks design and venue controls while pending', async () => {
    let resolveSave!: (value: { updatedAt: Date }) => void
    mocks.updateChatDesign.mockImplementationOnce(
      () => new Promise<{ updatedAt: Date }>((resolve) => (resolveSave = resolve)),
    )
    render(<ChatDesignForm venues={venues} />)

    const save = screen.getByRole('button', { name: 'Save design' })
    fireEvent.click(save)
    fireEvent.click(save)

    const saving = await screen.findByRole('button', { name: 'Saving...' })
    expect(mocks.updateChatDesign).toHaveBeenCalledOnce()
    expect((saving as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Venue') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Forest' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(
      (screen.getByRole('switch', { name: 'Use dark mode' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByLabelText('Custom accent colour') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Inter' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => resolveSave({ updatedAt: new Date('2026-08-11T14:31:00.000Z') }))
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
  })

  it('confirms dirty venue switches and loads the selected venue design truthfully', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<ChatDesignForm venues={venues} />)

    fireEvent.click(screen.getByRole('button', { name: 'Forest' }))
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: venues[1]!.id } })
    expect(confirm).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: venues[0]!.id } })

    fireEvent.click(screen.getByRole('button', { name: 'Sunset' }))
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: venues[1]!.id } })
    expect(confirm).toHaveBeenCalledOnce()
    expect(screen.getByLabelText<HTMLSelectElement>('Venue').value).toBe(venues[0]!.id)

    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: venues[1]!.id } })
    expect(screen.getByLabelText<HTMLSelectElement>('Venue').value).toBe(venues[1]!.id)
    expect(screen.getByRole('switch', { name: 'Use dark mode' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect((screen.getByRole('button', { name: 'Rose' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))
    await waitFor(() =>
      expect(mocks.updateChatDesign).toHaveBeenCalledWith({
        venueId: venues[1]!.id,
        expectedUpdatedAt: venues[1]!.updatedAt,
        chatTheme: 'dark',
        chatAccentColor: '#D4607A',
        chatFont: 'playfair',
      }),
    )
  })

  it('retains a failed design for retry and clears stale feedback when edited', async () => {
    mocks.updateChatDesign.mockRejectedValueOnce(new Error('Design conflict'))
    render(<ChatDesignForm venues={venues} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sunset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Design conflict')
    expect(screen.getByRole('button', { name: 'Sunset' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Poppins' }))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))
    expect(await screen.findByRole('status')).toBeTruthy()
  })

  it('resets unsaved changes to the last saved design without writing', () => {
    render(<ChatDesignForm venues={venues} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sunset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Poppins' }))
    expect(
      (screen.getByRole('button', { name: 'Reset changes' }) as HTMLButtonElement).disabled,
    ).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Reset changes' }))

    expect(screen.getByRole('button', { name: 'Forest' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Inter' }).getAttribute('aria-pressed')).toBe('true')
    expect(
      (screen.getByRole('button', { name: 'Reset changes' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(mocks.updateChatDesign).not.toHaveBeenCalled()
  })

  it('uses the canonical design returned by the save mutation for readback', async () => {
    mocks.updateChatDesign.mockResolvedValueOnce({
      chatTheme: 'midnight',
      chatAccentColor: '#123456',
      chatFont: 'dmSans',
      updatedAt: new Date('2026-08-11T14:31:00.000Z'),
    })
    render(<ChatDesignForm venues={venues} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sunset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Poppins' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))

    await screen.findByRole('status')
    expect(screen.getByRole('button', { name: 'Midnight' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(screen.getByRole('button', { name: 'DM Sans' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect((screen.getByLabelText('Custom accent colour') as HTMLInputElement).value).toBe(
      '#123456',
    )
    expect(
      (screen.getByRole('button', { name: 'Reset changes' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('keeps canonical saved design when switching venues and returning', async () => {
    mocks.updateChatDesign.mockResolvedValueOnce({
      chatTheme: 'sunset',
      chatAccentColor: '#ABCDEF',
      chatFont: 'poppins',
      updatedAt: new Date('2026-08-11T14:31:00.000Z'),
    })
    render(<ChatDesignForm venues={venues} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sunset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Poppins' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))
    await screen.findByRole('status')

    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: venues[1]!.id } })
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: venues[0]!.id } })

    expect(screen.getByRole('button', { name: 'Sunset' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Poppins' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect((screen.getByLabelText('Custom accent colour') as HTMLInputElement).value).toBe(
      '#ABCDEF',
    )
    expect(
      (screen.getByRole('button', { name: 'Reset changes' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('starts on the venue selected by the client route', () => {
    render(<ChatDesignForm venues={venues} initialVenueId={venues[1]!.id} />)

    expect((screen.getByLabelText('Venue') as HTMLSelectElement).value).toBe(venues[1]!.id)
    expect(screen.getByRole('switch', { name: 'Use dark mode' }).getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  it('renders a graceful empty state without a save control', () => {
    render(<ChatDesignForm venues={[]} />)

    expect(screen.getByText(/No venues found/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save design' })).toBeNull()
  })

  it('renders visitor branding read-only for restricted roles', () => {
    render(<ChatDesignForm venues={venues} canEdit={false} />)

    expect(screen.queryByRole('button', { name: 'Save design' })).toBeNull()
    expect(screen.getByText(/only venue managers and owners can edit/u)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Forest' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByLabelText('Custom accent colour') as HTMLInputElement).disabled).toBe(true)
  })
})
