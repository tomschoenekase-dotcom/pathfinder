/* @vitest-environment jsdom */
import React, { useLayoutEffect } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHAT_APPEARANCE } from '@pathfinder/contracts/chat-appearance'
import { DEFAULT_VISITOR_PREFERENCES } from '../lib/visitor-preferences'

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

const voiceCallbacks = vi.hoisted(() => ({
  current: null as null | {
    onAvailabilityChange: (available: boolean) => void
    onLiveCaptionChange: (caption: {
      responseId: string
      text: string
      interrupted: boolean
    }) => void
    onCaptionAnnouncement: (announcement: 'started' | 'interrupted') => void
  },
}))

vi.mock('./VoiceControl', () => {
  return {
    VoiceControl: ({
      onAvailabilityChange,
      onLiveCaptionChange,
      onCaptionAnnouncement,
    }: {
      venueId: string
      onAvailabilityChange: (available: boolean) => void
      onLiveCaptionChange: (caption: {
        responseId: string
        text: string
        interrupted: boolean
      }) => void
      onCaptionAnnouncement: (announcement: 'started' | 'interrupted') => void
    }) => {
      voiceCallbacks.current = {
        onAvailabilityChange,
        onLiveCaptionChange,
        onCaptionAnnouncement,
      }
      return <span data-testid="mock-voice-control" />
    },
  }
})

import { VenueChatShell } from './VenueChatShell'

function venue(id: string) {
  return {
    id,
    name: `${id} museum`,
    description: 'A welcoming guide to the collection.',
    category: 'MUSEUM' as const,
    guideMode: 'non_location' as const,
    defaultCenterLat: null,
    defaultCenterLng: null,
    aiGuideName: `${id} guide`,
    chatTheme: null,
    chatAccentColor: null,
    chatFont: null,
    chatLogoUrl: null,
    chatBannerUrl: null,
  }
}

function shellProps(id: string) {
  return {
    venue: venue(id),
    venueSlug: id,
    presentation: 'standalone' as const,
    messages: [],
    isSending: false,
    sendError: null,
    anonymousToken: 'fixture-token',
    language: 'English' as const,
    initialDraft: '',
    location: { lat: null, lng: null, permission: 'denied' as const, refresh: vi.fn() },
    connectionState: 'online' as const,
    onSend: vi.fn(),
    onNewConversation: vi.fn(),
    onPlaceView: vi.fn(),
    onPlaceClick: vi.fn(),
    onDirections: vi.fn(),
  }
}

function VenueSwitchHarness({
  venueId,
  layoutSnapshots,
}: {
  venueId: string
  layoutSnapshots: Array<{ caption: string | null; announcement: string | null }>
}) {
  useLayoutEffect(() => {
    if (venueId !== 'new-venue') return
    layoutSnapshots.push({
      caption: document.querySelector('[aria-label="Live voice caption"]')?.textContent ?? null,
      announcement:
        document.querySelector('[aria-label="Voice caption updates"]')?.textContent ?? null,
    })
  }, [venueId, layoutSnapshots])

  return <VenueChatShell {...shellProps(venueId)} />
}

describe('VenueChatShell venue scoped voice captions', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('does not render the previous venue caption or announcement before passive effects on switch', async () => {
    const layoutSnapshots: Array<{ caption: string | null; announcement: string | null }> = []
    const { rerender } = render(
      <VenueSwitchHarness venueId="old-venue" layoutSnapshots={layoutSnapshots} />,
    )

    const oldCallbacks = voiceCallbacks.current!
    act(() => {
      oldCallbacks.onAvailabilityChange(true)
      oldCallbacks.onLiveCaptionChange({
        responseId: 'old-venue-response',
        text: 'Caption from old-venue',
        interrupted: true,
      })
      oldCallbacks.onCaptionAnnouncement('interrupted')
    })
    expect(screen.getByText('Caption from old-venue')).toBeTruthy()
    expect(screen.getByText('Voice response interrupted. Finalizing caption.')).toBeTruthy()

    rerender(<VenueSwitchHarness venueId="new-venue" layoutSnapshots={layoutSnapshots} />)

    expect(layoutSnapshots).toEqual([{ caption: null, announcement: '' }])
    expect(screen.queryByText('Caption from old-venue')).toBeNull()
    const newCallbacks = voiceCallbacks.current!
    act(() => {
      newCallbacks.onLiveCaptionChange({
        responseId: 'new-venue-response',
        text: 'Caption from new-venue',
        interrupted: true,
      })
      newCallbacks.onCaptionAnnouncement('started')
    })
    expect(screen.getByText('Caption from new-venue')).toBeTruthy()
    expect(screen.getByText('Voice caption started.')).toBeTruthy()

    act(() => {
      oldCallbacks.onLiveCaptionChange({
        responseId: 'late-old-venue-response',
        text: 'Late caption from old-venue',
        interrupted: true,
      })
      oldCallbacks.onCaptionAnnouncement('interrupted')
    })
    expect(screen.queryByText('Late caption from old-venue')).toBeNull()
    expect(screen.getByText('Caption from new-venue')).toBeTruthy()
    expect(screen.getByText('Voice caption started.')).toBeTruthy()
    expect(screen.queryByText('Voice response interrupted. Finalizing caption.')).toBeNull()
  })

  it('draws the Space Museum sky only for its dark theme without a selected background', () => {
    const museumId = 'cmsg624n70003rx0190j8o941'
    const museum = { ...venue(museumId), chatTheme: 'dark' }
    const { container, rerender } = render(
      <VenueChatShell {...shellProps(museumId)} venue={museum} />,
    )
    const shell = () => container.querySelector('[data-starry]')
    expect(shell()).not.toBeNull()

    rerender(
      <VenueChatShell {...shellProps(museumId)} venue={{ ...museum, id: 'another-venue' }} />,
    )
    expect(shell()).toBeNull()

    rerender(
      <VenueChatShell {...shellProps(museumId)} venue={{ ...museum, chatTheme: 'default' }} />,
    )
    expect(shell()).toBeNull()

    rerender(
      <VenueChatShell
        {...shellProps(museumId)}
        venue={museum}
        preferences={{ ...DEFAULT_VISITOR_PREFERENCES, highContrast: true }}
      />,
    )
    expect(shell()).toBeNull()

    rerender(
      <VenueChatShell
        {...shellProps(museumId)}
        venue={{
          ...museum,
          chatAppearance: {
            ...DEFAULT_CHAT_APPEARANCE,
            background: { ...DEFAULT_CHAT_APPEARANCE.background, mode: 'image' },
          },
        }}
      />,
    )
    expect(shell()).toBeNull()
  })
})
