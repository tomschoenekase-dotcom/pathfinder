import { auth } from '@clerk/nextjs/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { DashboardOverview, type ClientPortalTask } from '../../components/DashboardOverview'
import { buildGuestChatUrl, buildSecondLayerChatUrl } from '../../lib/guest-chat-url'
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
  const [taskEvidence, secondLayer] = await Promise.all([
    caller.portal.getVenueTaskEvidence({ venueId: selectedVenue!.id }),
    caller.venue.getSecondLayer({ venueId: selectedVenue!.id }),
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
  const chatUrl = selectedVenue
    ? buildGuestChatUrl(process.env.NEXT_PUBLIC_WEB_URL, selectedVenue.slug, {
        allowLoopbackHttp: process.env.NODE_ENV === 'development',
      })
    : null
  const tasks: ClientPortalTask[] = taskEvidence.missingInformation.map((request) => ({
    id: `missing-information:${request.requestId}`,
    title: request.subject,
    description: 'Torchiko Support is waiting for the details below.',
    href: `/support?venue=${encodeURIComponent(selectedVenue!.id)}&request=${encodeURIComponent(request.requestId)}`,
    required: true,
    items: request.items,
    additionalItemCount: request.additionalItemCount,
  }))
  if (taskEvidence.additionalMissingRequest) {
    tasks.push({
      id: 'additional-support-questions',
      title: 'More questions are waiting in Support',
      description: 'Open Support to see the rest of the information requests for this venue.',
      href: `/support?venue=${encodeURIComponent(selectedVenue!.id)}`,
      required: true,
    })
  }
  if (
    selectedLifecycle.lifecycle.state === 'CLIENT_PREVIEW' &&
    selectedLifecycle.clientPreview.state === 'AVAILABLE' &&
    selectedLifecycle.clientPreview.id
  ) {
    tasks.push({
      id: 'review-preview',
      title: 'Review the visitor experience',
      description: 'See what visitors will experience and send any changes through Support.',
      href: `/venues/${encodeURIComponent(selectedVenue!.id)}/preview/${encodeURIComponent(selectedLifecycle.clientPreview.id)}`,
      required: true,
    })
  } else if (
    selectedLifecycle.lifecycle.state !== 'CLIENT_PREVIEW' &&
    selectedLifecycle.lifecycle.clientAction === 'OPEN_PREVIEW' &&
    chatUrl
  ) {
    tasks.push({
      id: 'open-visitor-experience',
      title: 'Open visitor experience',
      description: selectedLifecycle.lifecycle.summary,
      href: chatUrl,
      required: true,
    })
  } else if (
    selectedLifecycle.lifecycle.state === 'SETUP_REQUESTED' ||
    selectedLifecycle.lifecycle.state === 'COLLECTING'
  ) {
    tasks.push({
      id: 'share-information',
      title: taskEvidence.hasSharedInformation
        ? 'Share more useful information'
        : 'Share your starting information',
      description: taskEvidence.hasSharedInformation
        ? 'Add another website, staff answer, document, or image when it is ready.'
        : 'Start with a website, staff answer, document, or image. Rough source material is welcome.',
      href: `/venues/${encodeURIComponent(selectedVenue!.id)}/onboarding`,
      required: true,
    })
  } else if (
    selectedLifecycle.lifecycle.state === 'PROCESSING' ||
    selectedLifecycle.lifecycle.state === 'INTERNAL_REVIEW' ||
    selectedLifecycle.lifecycle.state === 'REVISIONS'
  ) {
    tasks.push({
      id: 'onboarding-progress',
      title: 'View onboarding progress',
      description:
        'See what Torchiko is working on, what is ready, and whether any focused questions need you.',
      href: `/venues/${encodeURIComponent(selectedVenue!.id)}/onboarding`,
      required: false,
    })
  }
  if (taskEvidence.latestReport) {
    tasks.push({
      id: `report:${taskEvidence.latestReport.id}`,
      title: taskEvidence.latestReport.title,
      description: 'A published Torchiko report is available to read.',
      href: `/weekly-reports/${encodeURIComponent(taskEvidence.latestReport.id)}?venue=${encodeURIComponent(selectedVenue!.id)}`,
      required: false,
    })
  }

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
      tasks={tasks.slice(0, 6)}
      secondLayer={{
        enabled: secondLayer.secondLayerEnabled,
        label: secondLayer.secondLayerLabel,
        updatedAt: secondLayer.updatedAt.toISOString(),
        url: secondLayer.secondLayerEnabled
          ? buildSecondLayerChatUrl(
              process.env.NEXT_PUBLIC_WEB_URL,
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
