/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('../../lib/intake-file-identity', async (load) => {
  const actual = await load<typeof import('../../lib/intake-file-identity')>()
  return {
    ...actual,
    // jsdom cannot stream-hash files; the transfer protocol is what these tests exercise.
    identifyIntakeFile: vi.fn(async (file: File) => {
      const hex = Array.from(`${file.name}:${file.size}`, (c) => c.charCodeAt(0).toString(16))
        .join('')
        .padEnd(64, '0')
        .slice(0, 64)
      return { sha256Hex: hex, sha256Base64: 'fixture' }
    }),
  }
})
vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => ({}) }))

import {
  BRANDING_REVIEW_SUBJECTS,
  LookAndFeelEditorView,
  type ApprovedBrandingAsset,
  type LookAndFeelApi,
} from './LookAndFeelEditor'

const banner: ApprovedBrandingAsset = {
  derivativeId: '12222222-2222-4222-8222-222222222222',
  assetId: '22222222-2222-4222-8222-222222222222',
  altText: 'Lake at dusk',
  deliveryPath: '/api/venue-media/12222222-2222-4222-8222-222222222222?venue=maple',
  sourceObjectGeneration: '32222222-2222-4222-8222-222222222222',
  sha256: 'b'.repeat(64),
  approvedReviewSequence: 2,
}

const venue = {
  id: 'venue-1',
  name: 'Maple Hollow Nature Center',
  slug: 'maple',
  updatedAt: '2026-09-20T12:00:00.000Z',
  chatTheme: 'forest',
  chatAccentColor: null,
  chatFont: 'jakarta',
  chatAppearance: null,
  chatLogoUrl: null,
  chatBannerUrl: null,
  chatLogoDerivativeId: null,
  chatBannerDerivativeId: banner.derivativeId,
}

function makeApi(overrides: Partial<LookAndFeelApi> = {}): LookAndFeelApi {
  return {
    reserve: vi.fn(async () => ({
      upload: { id: 'upload-logo', status: 'AWAITING_REVIEW' },
      uploadRequest: null,
    })),
    verify: vi.fn(),
    signMultipartPart: vi.fn(),
    completeMultipart: vi.fn(),
    saveDesign: vi.fn(async (input) => ({
      updatedAt: '2026-09-27T20:00:00.000Z',
      chatAppearance: input.chatAppearance,
    })),
    requestBrandingReview: vi.fn(async () => ({ request: { id: 'request-logo' } })),
    ...overrides,
  }
}

function renderEditor(props: Partial<Parameters<typeof LookAndFeelEditorView>[0]> = {}) {
  const api = props.api ?? makeApi()
  render(
    <LookAndFeelEditorView
      venues={[{ id: venue.id, name: venue.name }]}
      venue={venue}
      canEdit
      visibleToVisitors
      approvedAssets={[banner]}
      pendingReviews={{ logo: null, background: null }}
      previewOrigin={null}
      mediaOrigin="https://guide.example.com"
      api={api}
      {...props}
    />,
  )
  return api
}

function group(index: number) {
  return within(screen.getAllByRole('radiogroup')[index]!)
}

describe('Look & feel', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('saves four independent message colours and the bubble style, and nothing else it did not change', async () => {
    const api = renderEditor()
    fireEvent.click(screen.getByLabelText('Both in bubbles'))
    fireEvent.click(group(0).getByRole('radio', { name: 'Sage' }))
    fireEvent.click(group(1).getByRole('radio', { name: 'Charcoal' }))
    fireEvent.click(group(2).getByRole('radio', { name: 'Navy' }))
    fireEvent.click(group(3).getByRole('radio', { name: 'White' }))
    expect(screen.getByText('Unsaved changes. Only you can see them, in the preview.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved. Visitors see this design now.')
    const input = vi.mocked(api.saveDesign).mock.calls[0]![0]
    expect(input.chatAppearance).toMatchObject({
      userBubble: true,
      assistantBubble: true,
      userBubbleColor: '#DDEBE3',
      userTextColor: '#1C1C1C',
      assistantSurfaceColor: '#1F3A5F',
      assistantTextColor: '#FFFFFF',
    })
    expect(input.expectedUpdatedAt).toEqual(new Date(venue.updatedAt))
    expect('chatLogoDerivativeId' in input).toBe(false)
    expect('chatBannerDerivativeId' in input).toBe(false)
    expect('chatTheme' in input).toBe(false)
  })

  it('explains a colour visitors will not see instead of silently dropping it', () => {
    renderEditor()
    fireEvent.click(group(2).getByRole('radio', { name: 'Navy' }))
    expect(screen.getByText(/Guide answers have no bubble in this style/u)).toBeTruthy()
    fireEvent.click(group(0).getByRole('radio', { name: 'Sage' }))
    fireEvent.click(group(1).getByRole('radio', { name: 'White' }))
    expect(screen.getByText(/Too faint on this bubble, so visitors see #/u)).toBeTruthy()
  })

  it('removes the background photo explicitly and discards back to the saved design', async () => {
    const api = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Remove background photo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByRole('button', { name: 'Remove background photo' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove background photo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.saveDesign).toHaveBeenCalled())
    const input = vi.mocked(api.saveDesign).mock.calls[0]![0]
    expect(input.chatBannerDerivativeId).toBeNull()
    expect(input.chatBannerDerivativeReceipt).toBeNull()
    expect(input.chatAppearance.background.mode).toBe('none')
  })

  it('keeps unsaved work when a save fails, and says so', async () => {
    renderEditor({
      api: makeApi({ saveDesign: vi.fn(async () => Promise.reject(new Error('down'))) }),
    })
    fireEvent.click(group(0).getByRole('radio', { name: 'Sage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/weren’t saved. They’re still here/u)).toBeTruthy()
    expect(group(0).getByRole<HTMLInputElement>('radio', { name: 'Sage' }).checked).toBe(true)
  })

  it('sends a new logo to Torchiko for review instead of claiming it is live', async () => {
    const api = renderEditor()
    const input = document.querySelector<HTMLInputElement>('input[type=file][accept*="image/png"]')!
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' })] },
    })
    expect(
      await screen.findByText(/Sent for review. Visitors will see it once Torchiko approves it./u),
    ).toBeTruthy()
    expect(api.requestBrandingReview).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'BRANDING',
        subject: BRANDING_REVIEW_SUBJECTS.logo,
        attachments: [{ intakeUploadId: 'upload-logo' }],
        venueId: 'venue-1',
      }),
    )
    expect(api.saveDesign).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'View in Help' }).getAttribute('href')).toBe(
      '/support?venue=venue-1&request=request-logo',
    )
  })

  it('rejects files that cannot become a branding image before uploading', () => {
    const api = renderEditor()
    const input = document.querySelector<HTMLInputElement>('input[type=file][accept*="image/png"]')!
    fireEvent.change(input, {
      target: { files: [new File(['%PDF'], 'logo.pdf', { type: 'application/pdf' })] },
    })
    expect(screen.getByText('Choose a PNG, JPG or WebP image.')).toBeTruthy()
    expect(api.reserve).not.toHaveBeenCalled()
  })

  it('shows staff the design without any way to change it', () => {
    renderEditor({ canEdit: false })
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    expect(screen.queryByText('Upload')).toBeNull()
    expect(group(0).getByRole('radio', { name: 'Sage' }).closest('fieldset')?.disabled).toBe(true)
    expect(screen.getByText(/A manager or owner on your team can change it/u)).toBeTruthy()
  })

  it('states when the live preview is not available rather than showing an imitation', () => {
    renderEditor()
    expect(
      screen.getAllByText(/live preview isn’t available in this environment/u).length,
    ).toBeGreaterThan(0)
    expect(document.querySelector('iframe')).toBeNull()
  })
})
