import { auth } from '@pathfinder/auth/server'
import { redirect } from 'next/navigation'

import { DashboardOverview, type HomeGuideState } from '../../components/DashboardOverview'
import { buildGuestChatUrl, resolveGuestWebOrigin } from '../../lib/guest-chat-url'
import { isManagerRole, isOwnerRole, resolvePaymentAvailable } from '../../lib/portal-capabilities'
import { buildHomeRequests } from '../../lib/portal-home-requests'
import { createDashboardCaller } from '../../lib/server-caller'

type DashboardIndexPageProps = {
  searchParams: Promise<{ venue?: string }>
}

const PUBLISHED_STATES = new Set(['READY', 'LIVE', 'REVISIONS'])

export default async function DashboardIndexPage({ searchParams }: DashboardIndexPageProps) {
  const caller = await createDashboardCaller('/')
  const [venues, lifecycleRows] = await Promise.all([
    caller.venue.list(),
    caller.portal.getVenueLifecycles(),
  ])

  if (venues.length === 0) {
    redirect('/onboarding/setup')
  }

  const { orgRole, sessionClaims } = await auth()
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'

  const { venue: requestedVenueId } = await searchParams
  const selectedVenue = venues.find((venue) => venue.id === requestedVenueId) ?? venues[0]!
  const selectedLifecycle = lifecycleRows.find((row) => row.venueId === selectedVenue.id)
  if (!selectedLifecycle) throw new Error('Portal lifecycle evidence is unavailable')
  const lifecycle = selectedLifecycle.lifecycle

  const [supportPage, paymentAvailable] = await Promise.all([
    caller.support.listRequests({ venueId: selectedVenue.id }),
    resolvePaymentAvailable(caller),
  ])

  const chatUrl = buildGuestChatUrl(
    resolveGuestWebOrigin(process.env.NEXT_PUBLIC_WEB_URL, process.env.RAILWAY_ENVIRONMENT),
    selectedVenue.slug,
    { allowLoopbackHttp: process.env.NODE_ENV === 'development' },
  )
  const guide: HomeGuideState = PUBLISHED_STATES.has(lifecycle.state)
    ? chatUrl
      ? { kind: 'published', url: chatUrl }
      : { kind: 'link-unavailable' }
    : lifecycle.state === 'PAUSED'
      ? { kind: 'paused' }
      : lifecycle.state === 'CLIENT_PREVIEW'
        ? { kind: 'preview' }
        : { kind: 'building' }

  return (
    <DashboardOverview
      venue={{ id: selectedVenue.id, name: selectedVenue.name }}
      venues={venues.map((venue) => ({ id: venue.id, name: venue.name }))}
      guide={guide}
      requests={buildHomeRequests({
        venueId: selectedVenue.id,
        lifecycle,
        clientPreview: selectedLifecycle.clientPreview,
        supportRequests: supportPage.items,
      })}
      canSendLinksAndNotes={isManagerRole(orgRole, isPlatformAdmin)}
      payment={{ available: paymentAvailable, canPay: isOwnerRole(orgRole, isPlatformAdmin) }}
    />
  )
}
