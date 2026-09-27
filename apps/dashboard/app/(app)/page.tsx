import { auth } from '@pathfinder/auth/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { DashboardOverview } from '../../components/DashboardOverview'
import { buildVenueAccessArtifacts } from '@pathfinder/contracts/venue-access-artifacts'
import { getChatPalette } from '@pathfinder/ui/theme'
import {
  buildGuestChatUrl,
  buildSecondLayerChatUrl,
  resolveGuestWebOrigin,
} from '../../lib/guest-chat-url'
import { buildPortalHomeTasks } from '../../lib/portal-home-tasks'
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
  const showVisitorPulse =
    selectedLifecycle.lifecycle.state === 'LIVE' || selectedLifecycle.lifecycle.state === 'PAUSED'
  const [taskEvidence, secondLayer, visitorPulse, distributionReadback] = await Promise.all([
    caller.portal.getVenueTaskEvidence({ venueId: selectedVenue!.id }),
    caller.venue.getSecondLayer({ venueId: selectedVenue!.id }),
    showVisitorPulse
      ? caller.portal.getVenueVisitorPulse({ venueId: selectedVenue!.id })
      : Promise.resolve(null),
    caller.tenant.venueDistribution.readback({ venueId: selectedVenue!.id }).catch(() => null),
  ])
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
  const guideOrigin = resolveGuestWebOrigin(
    process.env.NEXT_PUBLIC_WEB_URL,
    process.env.RAILWAY_ENVIRONMENT,
  )
  const chatUrl = selectedVenue
    ? buildGuestChatUrl(guideOrigin, selectedVenue.slug, {
        allowLoopbackHttp: process.env.NODE_ENV === 'development',
      })
    : null
  const accessArtifacts = selectedVenue
    ? buildVenueAccessArtifacts(process.env.NEXT_PUBLIC_WEB_URL, selectedVenue.slug, {
        allowLoopbackHttp: process.env.NODE_ENV === 'development',
        ...(distributionReadback
          ? {
              appBackground: getChatPalette(
                distributionReadback.venue.chatTheme,
                distributionReadback.venue.chatAccentColor,
              ).bg,
            }
          : {}),
      })
    : null
  const tasks = buildPortalHomeTasks({
    venueId: selectedVenue!.id,
    lifecycle: selectedLifecycle.lifecycle,
    clientPreview: selectedLifecycle.clientPreview,
    chatUrl,
    evidence: taskEvidence,
  })

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
      tasks={tasks}
      visitorPulse={visitorPulse}
      distributionReadback={
        distributionReadback
          ? {
              website: distributionReadback.website,
              app: distributionReadback.app,
              revision: distributionReadback.revision,
              sessions30d: distributionReadback.sessions30d,
              publicUrl: accessArtifacts?.publicUrl ?? null,
              appUrl: accessArtifacts?.appUrl ?? null,
              appBackground: accessArtifacts?.appBackground ?? null,
            }
          : null
      }
      secondLayer={{
        enabled: secondLayer.secondLayerEnabled,
        label: secondLayer.secondLayerLabel,
        updatedAt: secondLayer.updatedAt.toISOString(),
        url: secondLayer.secondLayerEnabled
          ? buildSecondLayerChatUrl(
              guideOrigin,
              secondLayer.slug,
              secondLayer.secondLayerAccessKey,
              { allowLoopbackHttp: process.env.NODE_ENV === 'development' },
            )
          : null,
      }}
      {...(impersonatedTenantName !== undefined ? { impersonatedTenantName } : {})}
    />
  )
}
