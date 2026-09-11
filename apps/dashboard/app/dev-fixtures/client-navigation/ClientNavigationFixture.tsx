'use client'

import type { MouseEvent, ReactNode } from 'react'
import { useRouter } from 'next/navigation'

import { DashboardShellView } from '../../../components/DashboardShell'
import { TRPCProvider } from '../../../lib/trpc'

const VENUE_ID = 'fixture-great-lakes-museum'
const ALLOWED_TARGETS = new Set([
  `/venues/${VENUE_ID}/onboarding`,
  `/support?venue=${VENUE_ID}&returnTo=%2Fvenues%2F${VENUE_ID}%2Fonboarding`,
  `/?venue=${VENUE_ID}`,
  `/venues/${VENUE_ID}/qr-kit`,
])

export function ClientNavigationFixture({
  target,
  children,
}: {
  target: string
  children: ReactNode
}) {
  const router = useRouter()
  const targetUrl = new URL(target, 'https://fixture.invalid')
  const selectedVenueId = targetUrl.searchParams.get('venue')

  function captureFixtureNavigation(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href || !ALLOWED_TARGETS.has(href)) return
    event.preventDefault()
    router.push(`/dev-fixtures/client-navigation?target=${encodeURIComponent(href)}`)
  }

  return (
    <TRPCProvider scopeKey="fixture:client-navigation:tenant">
      <div
        data-fixture="client-navigation"
        data-synthetic-route-adapter="known-client-routes-only"
        onClickCapture={captureFixtureNavigation}
      >
        <DashboardShellView
          pathname={new URL(target, 'https://fixture.invalid').pathname}
          selectedVenueId={selectedVenueId}
          orgName="Lakeside Museums"
          isPlatformAdmin={false}
          routeKey={target}
          signOutControl={<button type="button">Sign out</button>}
        >
          {children}
        </DashboardShellView>
      </div>
    </TRPCProvider>
  )
}
