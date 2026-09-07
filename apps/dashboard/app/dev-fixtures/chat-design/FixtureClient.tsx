'use client'

import { useEffect, useRef, useState } from 'react'

import { ChatDesignForm } from '../../../components/ChatDesignForm'
import { TRPCProvider } from '../../../lib/trpc'

const venues = [
  {
    id: 'fixture-venue',
    name: 'Harbor House',
    slug: 'harbor-house',
    chatTheme: 'forest',
    chatAccentColor: '#245A4A',
    chatFont: 'inter',
    chatLogoUrl: 'https://cdn.example.test/harbor-logo.png',
    chatBannerUrl: 'https://cdn.example.test/harbor-banner.png',
    chatShowPhotos: false,
    chatShowLinks: false,
    updatedAt: new Date('2026-08-19T12:00:00.000Z'),
  },
  {
    id: 'fixture-venue-2',
    name: 'Civic Gallery',
    slug: 'civic-gallery',
    chatTheme: 'sunset',
    chatAccentColor: null,
    chatFont: 'dmSans',
    chatLogoUrl: null,
    chatBannerUrl: null,
    updatedAt: new Date('2026-08-19T12:00:00.000Z'),
  },
]

const brandingAssetsByVenue = {
  'fixture-venue': {
    items: [
      {
        derivativeId: 'fixture-logo-derivative',
        assetId: 'fixture-logo-asset',
        altText: 'Harbor House mark',
        caption: null,
        deliveryPath: '/api/venue-media/fixture-logo-derivative?venue=harbor-house',
        sourceObjectGeneration: 'fixture-generation-logo',
        sha256: 'a'.repeat(64),
        approvedReviewSequence: 2,
      },
      {
        derivativeId: 'fixture-banner-derivative',
        assetId: 'fixture-banner-asset',
        altText: 'Harbor House banner',
        caption: null,
        deliveryPath: '/api/venue-media/fixture-banner-derivative?venue=harbor-house',
        sourceObjectGeneration: 'fixture-generation-banner',
        sha256: 'b'.repeat(64),
        approvedReviewSequence: 3,
      },
    ],
    nextCursor: null,
  },
  'fixture-venue-2': {
    items: [
      {
        derivativeId: 'fixture-gallery-logo-derivative',
        assetId: 'fixture-gallery-logo-asset',
        altText: 'Civic Gallery mark',
        caption: null,
        deliveryPath: '/api/venue-media/fixture-gallery-logo-derivative?venue=civic-gallery',
        sourceObjectGeneration: 'fixture-generation-gallery',
        sha256: 'c'.repeat(64),
        approvedReviewSequence: 1,
      },
    ],
    nextCursor: null,
  },
} as const

type FixtureDesign = {
  chatTheme: string
  chatAccentColor: string | null
  chatFont: string
  chatLogoUrl?: string | null
  chatBannerUrl?: string | null
  chatLogoDerivativeId?: string | null
  chatBannerDerivativeId?: string | null
  chatShowPhotos?: boolean
  chatShowLinks?: boolean
  updatedAt: Date
}

const STORAGE_KEY = 'pathfinder:fixture:chat-design'
const BASE_REVISION = Date.parse('2026-08-19T12:00:00.000Z')

function defaultDesigns() {
  return new Map<string, FixtureDesign>(
    venues.map((venue) => [
      venue.id,
      {
        chatTheme: venue.chatTheme,
        chatAccentColor: venue.chatAccentColor,
        chatFont: venue.chatFont,
        updatedAt: venue.updatedAt,
        chatLogoDerivativeId: null,
        chatBannerDerivativeId: null,
      },
    ]),
  )
}

export function ChatDesignFixtureClient({ canEdit }: { canEdit: boolean }) {
  const [savedDesigns, setSavedDesigns] = useState<Map<string, FixtureDesign> | null>(null)
  const revision = useRef(0)

  useEffect(() => {
    const defaults = defaultDesigns()
    try {
      const stored = window.sessionStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, Omit<FixtureDesign, 'updatedAt'>>
        for (const venue of venues) {
          const design = parsed[venue.id]
          if (design) defaults.set(venue.id, { ...design, updatedAt: venue.updatedAt })
        }
      }
    } catch {
      // Fixture persistence is best effort; defaults remain authoritative.
    }
    setSavedDesigns(defaults)
  }, [])

  if (!savedDesigns) {
    return (
      <main className="min-h-screen bg-pf-surface px-4 py-8 text-pf-deep sm:px-8 sm:py-12">
        <div className="mx-auto max-w-5xl" role="status">
          Loading client branding fixture…
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-pf-surface px-4 py-8 text-pf-deep sm:px-8 sm:py-12">
      <div className="mx-auto max-w-5xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
          Development fixture · client branding
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          Customize the visitor chat
        </h1>
        <p className="mb-8 mt-3 max-w-2xl text-sm leading-6 text-pf-deep/70">
          Deterministic MANAGER/OWNER client editor fixture. Saves use an in-browser adapter so this
          journey exercises the canonical form without a database or provider.
        </p>
        <TRPCProvider scopeKey="fixture:chat-design">
          <ChatDesignForm
            venues={venues.map((venue) => ({ ...venue, ...savedDesigns.get(venue.id) }))}
            brandingAssetsByVenue={brandingAssetsByVenue}
            canEdit={canEdit}
            updateDesign={async (input) => {
              const saved: FixtureDesign = {
                chatTheme: input.chatTheme,
                chatAccentColor: input.chatAccentColor,
                chatFont: input.chatFont,
                chatLogoUrl: input.chatLogoUrl ?? null,
                chatBannerUrl: input.chatBannerUrl ?? null,
                chatLogoDerivativeId: input.chatLogoDerivativeId ?? null,
                chatBannerDerivativeId: input.chatBannerDerivativeId ?? null,
                chatShowPhotos: input.chatShowPhotos,
                chatShowLinks: input.chatShowLinks,
                updatedAt: new Date(BASE_REVISION + ++revision.current),
              }
              const next = new Map(savedDesigns).set(input.venueId, saved)
              setSavedDesigns(next)
              window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(next)))
              return saved
            }}
          />
        </TRPCProvider>
        <div className="sr-only" aria-live="polite" data-testid="fixture-save-readback">
          {JSON.stringify(Object.fromEntries(savedDesigns))}
        </div>
      </div>
    </main>
  )
}
