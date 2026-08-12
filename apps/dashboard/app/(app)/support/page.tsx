import { redirect } from 'next/navigation'

import { SupportWorkspace } from '../../../components/SupportWorkspace'
import { createDashboardCaller } from '../../../lib/server-caller'

type SupportPageProps = {
  searchParams: Promise<{ venue?: string | string[]; request?: string | string[] }>
}

export default async function SupportPage({ searchParams }: SupportPageProps) {
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
    />
  )
}
