import { auth } from '@clerk/nextjs/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { DashboardOverview } from '../../components/DashboardOverview'
import { buildGuestChatUrl } from '../../lib/guest-chat-url'
import { createDashboardCaller } from '../../lib/server-caller'

type DashboardIndexPageProps = {
  searchParams: Promise<{ venue?: string }>
}

export default async function DashboardIndexPage({ searchParams }: DashboardIndexPageProps) {
  const caller = await createDashboardCaller('/')
  const [venues, operationalUpdates, lifecycleRows] = await Promise.all([
    caller.venue.list(),
    caller.operationalUpdate.list(),
    caller.portal.getVenueLifecycles(),
  ])

  const { sessionClaims } = await auth()
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  const adminTenantOverride = (await cookies()).get('pf_admin_tenant')?.value
  let impersonatedTenantName: string | undefined
  if (isPlatformAdmin && adminTenantOverride) {
    const { tenant } = await caller.tenant.getSettings()
    impersonatedTenantName = tenant.name
  }

  if (venues.length === 0) {
    redirect('/onboarding/setup')
  }

  const { venue: requestedVenueId } = await searchParams
  const selectedVenue = venues.find((venue) => venue.id === requestedVenueId) ?? venues[0] ?? null
  const selectedLifecycle = lifecycleRows.find((row) => row.venueId === selectedVenue?.id)
  if (!selectedLifecycle) throw new Error('Portal lifecycle evidence is unavailable')
  type OperationalUpdateItem = (typeof operationalUpdates)[number]
  const now = new Date()
  const activeAlerts = operationalUpdates.filter(
    (update: OperationalUpdateItem) =>
      update.status === 'PUBLISHED' &&
      update.isActive &&
      update.venueId === selectedVenue?.id &&
      update.startsAt <= now &&
      update.expiresAt > now,
  ).length
  const chatUrl = selectedVenue
    ? buildGuestChatUrl(process.env.NEXT_PUBLIC_WEB_URL, selectedVenue.slug, {
        allowLoopbackHttp: process.env.NODE_ENV === 'development',
      })
    : null

  return (
    <DashboardOverview
      venue={{
        id: selectedVenue!.id,
        name: selectedVenue!.name,
        lifecycle: selectedLifecycle.lifecycle,
        clientPreview: selectedLifecycle.clientPreview,
      }}
      venues={venues.map((venue) => ({ id: venue.id, name: venue.name }))}
      activeUpdates={activeAlerts}
      chatUrl={chatUrl}
      {...(impersonatedTenantName !== undefined ? { impersonatedTenantName } : {})}
    />
  )
}
