/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => {
  const updateChatDesign = vi.fn()
  const listBrandingAssets = vi.fn()
  return {
    updateChatDesign,
    listBrandingAssets,
    client: {
      venue: {
        updateChatDesign: { mutate: updateChatDesign },
        listApprovedBrandingAssets: { query: listBrandingAssets },
      },
    },
  }
})

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => mocks.client,
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
    mocks.listBrandingAssets.mockResolvedValue({ items: [], nextCursor: null })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('saves dependent governed photo preferences and keeps credits visible when links are off', async () => {
    render(<ChatDesignForm venues={venues} />)
    const links = screen.getByLabelText('Link photo credits to their source') as HTMLInputElement
    expect(links.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Show reviewed photos for places mentioned in an answer'))
    expect(links.disabled).toBe(false)
    fireEvent.click(links)
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))
    await waitFor(() =>
      expect(mocks.updateChatDesign).toHaveBeenCalledWith(
        expect.objectContaining({
          venueId: venues[0]!.id,
          expectedUpdatedAt: venues[0]!.updatedAt,
          chatShowPhotos: true,
          chatShowLinks: true,
        }),
      ),
    )
    expect(
      screen.getByText('Photo credits remain visible as text when source links are off.'),
    ).toBeTruthy()
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
        chatShowPhotos: false,
        chatShowLinks: false,
      }),
    )
    expect((await screen.findByRole('status')).textContent).toContain('Design saved')
  })

  it('links to the real renderer with unsaved theme, accent, and font choices without mutating venue data', () => {
    render(<ChatDesignForm venues={venues} previewOrigin="https://staging-web.example.test" />)

    expect(screen.getByText(/Showing the saved appearance/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Sunset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Poppins' }))
    fireEvent.change(screen.getByLabelText('Custom accent colour'), {
      target: { value: '#ABCDEF' },
    })

    expect(screen.getByText(/Unsaved changes/)).toBeTruthy()
    const previewLink = screen.getByRole('link', { name: 'Preview unsaved appearance' })
    expect(previewLink.getAttribute('target')).toBe('_blank')
    expect(previewLink.getAttribute('rel')).toContain('noreferrer')
    const previewUrl = new URL(previewLink.getAttribute('href')!)
    expect(previewUrl.pathname).toBe('/appearance-preview')
    expect(previewUrl.searchParams.get('theme')).toBe('sunset')
    expect(previewUrl.searchParams.get('font')).toBe('poppins')
    expect(previewUrl.searchParams.get('accent')).toBe('#ABCDEF')
    expect(Array.from(previewUrl.searchParams.keys())).toEqual(['theme', 'font', 'accent'])
    expect(mocks.updateChatDesign).not.toHaveBeenCalled()
  })

  it('omits an invalid custom accent from the preview URL and explains the fallback', () => {
    render(<ChatDesignForm venues={venues} previewOrigin="https://staging-web.example.test" />)

    fireEvent.change(screen.getByLabelText('Custom accent colour'), { target: { value: 'blue' } })

    expect(screen.getByRole('note').textContent).toContain('selected theme colour')
    const previewUrl = new URL(
      screen.getByRole('link', { name: 'Preview unsaved appearance' }).getAttribute('href')!,
    )
    expect(previewUrl.searchParams.has('accent')).toBe(false)
    expect(mocks.updateChatDesign).not.toHaveBeenCalled()
  })

  it('offers the selected venue visitor guide only after a successful save', async () => {
    render(
      <ChatDesignForm
        venues={venues}
        previewOrigin="https://staging-web.example.test"
        visitorUrlsByVenue={{
          [venues[0]!.id]: 'https://staging-web.example.test/science-museum/chat?source=dashboard',
        }}
      />,
    )

    expect(screen.queryByRole('link', { name: 'Open saved visitor guide' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sunset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))

    const visitorLink = await screen.findByRole('link', { name: 'Open saved visitor guide' })
    expect(visitorLink.getAttribute('href')).toBe(
      'https://staging-web.example.test/science-museum/chat?source=dashboard',
    )
    expect(screen.getByText(/persisted appearance/)).toBeTruthy()
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
        chatShowPhotos: false,
        chatShowLinks: false,
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

  it('honors a canonical null accent instead of claiming the submitted override was saved', async () => {
    mocks.updateChatDesign.mockResolvedValueOnce({
      chatTheme: 'forest',
      chatAccentColor: null,
      chatFont: 'inter',
      updatedAt: new Date('2026-08-11T14:31:00.000Z'),
    })
    render(<ChatDesignForm venues={venues} previewOrigin="https://staging-web.example.test" />)
    fireEvent.change(screen.getByLabelText('Custom accent colour'), {
      target: { value: '#ABCDEF' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))
    await screen.findByRole('status')
    expect(screen.getByLabelText<HTMLInputElement>('Custom accent colour').value).toBe('')
    const preview = new URL(
      screen.getByRole('link', { name: 'Preview appearance' }).getAttribute('href')!,
    )
    expect(preview.searchParams.has('accent')).toBe(false)
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: venues[1]!.id } })
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: venues[0]!.id } })
    expect(screen.getByLabelText<HTMLInputElement>('Custom accent colour').value).toBe('')
  })

  it('reconciles cleared canonical derivative selections before the next save', async () => {
    const derivativeId = '11111111-1111-4111-8111-111111111111'
    const brandedVenue = {
      ...venues[0]!,
      chatLogoDerivativeId: derivativeId,
      chatBannerDerivativeId: derivativeId,
    }
    mocks.updateChatDesign.mockResolvedValueOnce({
      chatLogoDerivativeId: null,
      chatBannerDerivativeId: null,
      updatedAt: new Date('2026-08-11T14:31:00.000Z'),
    })
    render(
      <ChatDesignForm
        venues={[brandedVenue]}
        brandingAssetsByVenue={{
          [brandedVenue.id]: {
            items: [
              {
                derivativeId,
                assetId: '22222222-2222-4222-8222-222222222222',
                altText: 'Reviewed fixture asset',
                caption: null,
                deliveryPath: '/api/venue-media/fixture',
              },
            ],
            nextCursor: null,
          },
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))
    await screen.findByRole('status')
    expect(screen.getByLabelText<HTMLSelectElement>('logo asset').value).toBe('')
    expect(screen.getByLabelText<HTMLSelectElement>('banner asset').value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))
    await waitFor(() => expect(mocks.updateChatDesign).toHaveBeenCalledTimes(2))
    expect(mocks.updateChatDesign.mock.calls[1]![0]).not.toHaveProperty('chatLogoDerivativeId')
    expect(mocks.updateChatDesign.mock.calls[1]![0]).not.toHaveProperty('chatBannerDerivativeId')
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

  it('loads later reviewed assets and submits their exact immutable receipt', async () => {
    const brandedVenue = { ...venues[0]!, chatLogoDerivativeId: null, chatBannerDerivativeId: null }
    const first = {
      derivativeId: '11111111-1111-4111-8111-111111111111',
      assetId: '22222222-2222-4222-8222-222222222222',
      altText: 'First approved logo',
      caption: null,
      deliveryPath: '/api/venue-media/first',
      sourceObjectGeneration: '33333333-3333-4333-8333-333333333333',
      sha256: 'a'.repeat(64),
      approvedReviewSequence: 1,
    }
    const later = {
      derivativeId: '44444444-4444-4444-8444-444444444444',
      assetId: '55555555-5555-4555-8555-555555555555',
      altText: 'Later approved logo',
      caption: null,
      deliveryPath: '/api/venue-media/later',
      sourceObjectGeneration: '66666666-6666-4666-8666-666666666666',
      sha256: 'b'.repeat(64),
      approvedReviewSequence: 3,
    }
    mocks.listBrandingAssets.mockResolvedValueOnce({ items: [later], nextCursor: null })
    render(
      <ChatDesignForm
        venues={[brandedVenue]}
        brandingAssetsByVenue={{ [brandedVenue.id]: { items: [], nextCursor: first.derivativeId } }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load more reviewed assets' }))
    expect(await screen.findAllByRole('option', { name: later.altText })).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('logo asset'), { target: { value: later.derivativeId } })
    fireEvent.click(screen.getByRole('button', { name: 'Save design' }))
    await waitFor(() =>
      expect(mocks.updateChatDesign).toHaveBeenCalledWith(
        expect.objectContaining({
          chatLogoDerivativeId: later.derivativeId,
          chatLogoDerivativeReceipt: {
            assetId: later.assetId,
            derivativeId: later.derivativeId,
            sourceObjectGeneration: later.sourceObjectGeneration,
            sha256: later.sha256,
            approvedReviewSequence: later.approvedReviewSequence,
          },
        }),
      ),
    )
    expect(mocks.listBrandingAssets).toHaveBeenCalledWith(
      { venueId: brandedVenue.id, cursor: first.derivativeId },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('aborts the current venue transport on switch and the replacement transport on unmount', async () => {
    const signals: AbortSignal[] = []
    mocks.listBrandingAssets.mockImplementation((_input, options) => {
      signals.push(options.signal)
      return new Promise(() => undefined)
    })
    const cursor = '11111111-1111-4111-8111-111111111111'
    const rendered = render(
      <ChatDesignForm
        venues={venues}
        brandingAssetsByVenue={{
          [venues[0]!.id]: { items: [], nextCursor: cursor },
          [venues[1]!.id]: { items: [], nextCursor: cursor },
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load more reviewed assets' }))
    await waitFor(() => expect(signals).toHaveLength(1))
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: venues[1]!.id } })
    expect(signals[0]?.aborted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Load more reviewed assets' }))
    await waitFor(() => expect(signals).toHaveLength(2))
    rendered.unmount()
    expect(signals[1]?.aborted).toBe(true)
  })
})
