import { notFound } from 'next/navigation'

import { ClientPortalFixture } from '../client-portal/ClientPortalFixture'

// Earlier home-journey states, mapped onto the current four-job Home.
const STATES = {
  'first-run': 'building',
  'needs-input': 'live',
  preview: 'preview',
  pending: 'live',
  launched: 'live',
  quiet: 'quiet',
  paused: 'paused',
} as const

export default async function PortalJourneysFixture({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>
}) {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  const raw = (await searchParams).state
  const requested = (Array.isArray(raw) ? raw[0] : raw) ?? 'first-run'
  const state = STATES[requested as keyof typeof STATES] ?? 'building'
  return (
    <ClientPortalFixture
      page="home"
      state={state}
      role="owner"
      options={{ payment: 'paid', uploads: 'ok', send: 'ok', save: 'ok' }}
      webOrigin="https://guide.example.com"
    />
  )
}
