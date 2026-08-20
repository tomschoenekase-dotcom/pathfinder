import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { cookies } from 'next/headers'

import { SupportWorkspace } from '../../../components/SupportWorkspace'
import { createDashboardCaller } from '../../../lib/server-caller'
import { resolveOnboardingReturn } from '../../../lib/onboarding-return'

type SupportPageProps = {
  searchParams: Promise<{
    venue?: string | string[]
    request?: string | string[]
    returnTo?: string | string[]
  }>
}

export default async function SupportPage({ searchParams }: SupportPageProps) {
  const { sessionClaims } = await auth()
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: unknown } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  const adminTenantOverride = isPlatformAdmin
    ? (await cookies()).get('pf_admin_tenant')?.value
    : undefined
  const caller = await createDashboardCaller('/support')
  const venues = await caller.venue.list()

  if (venues.length === 0) redirect('/onboarding/setup')

  const query = await searchParams
  const requested = query.venue
  const requestedVenueId = Array.isArray(requested) ? requested[0] : requested
  const requestedRequest = Array.isArray(query.request) ? query.request[0] : query.request
  const requestedRequestId =
    requestedRequest && requestedRequest.length <= 191 ? requestedRequest : undefined
  const selectedVenue = venues.find((venue) => venue.id === requestedVenueId) ?? venues[0]!
  const returnHref = query.returnTo
    ? resolveOnboardingReturn(query.returnTo, selectedVenue.id, 'QUESTIONS')
    : undefined
  const [requestPage, eligibleAttachments] = await Promise.all([
    caller.support.listRequests({ venueId: selectedVenue.id }),
    caller.support.listEligibleAttachments({ venueId: selectedVenue.id, limit: 20 }),
  ])
  const firstRequest = requestPage.items[0]
  let initialDetail: Awaited<ReturnType<typeof caller.support.getRequest>> | null = null
  if (requestedRequestId) {
    initialDetail = await caller.support
      .getRequest({ venueId: selectedVenue.id, requestId: requestedRequestId })
      .catch(() => null)
  } else if (firstRequest) {
    initialDetail = await caller.support.getRequest({
      venueId: selectedVenue.id,
      requestId: firstRequest.id,
    })
  }

  return (
    <SupportWorkspace
      key={selectedVenue.id}
      venues={venues.map((venue) => ({ id: venue.id, name: venue.name }))}
      activeVenue={{ id: selectedVenue.id, name: selectedVenue.name }}
      initialRequests={requestPage.items}
      initialNextCursor={requestPage.nextCursor}
      initialDetail={initialDetail}
      initialEligibleAttachments={eligibleAttachments.items}
      initialEligibleAttachmentsNextCursor={eligibleAttachments.nextCursor}
      operatorSupportHref={
        adminTenantOverride
          ? `/admin/clients/${adminTenantOverride}/venues/${selectedVenue.id}/support-operations`
          : undefined
      }
      returnHref={returnHref}
    />
  )
}
