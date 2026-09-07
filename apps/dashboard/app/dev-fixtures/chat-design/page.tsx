import { notFound } from 'next/navigation'

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

export default function ChatDesignFixture() {
  if (process.env.NODE_ENV !== 'development') notFound()

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
          Deterministic MANAGER/OWNER client editor fixture. The save adapter is intentionally
          unavailable; persistence and role behavior are covered by the venue API and component
          tests.
        </p>
        <TRPCProvider scopeKey="fixture:chat-design">
          <ChatDesignForm venues={venues} />
        </TRPCProvider>
      </div>
    </main>
  )
}
