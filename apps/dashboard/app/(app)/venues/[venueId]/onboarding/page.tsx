export const dynamic = 'force-dynamic'

import type { Metadata } from 'next'

import { RemoteOnboardingJourney } from '../../../../../components/RemoteOnboardingJourney'
import { createDashboardCaller } from '../../../../../lib/server-caller'

export const metadata: Metadata = {
  title: 'Venue onboarding | Torchiko',
}

export default async function RemoteOnboardingPage({
  params,
}: {
  params: Promise<{ venueId: string }>
}) {
  const { venueId } = await params
  const caller = await createDashboardCaller(`/venues/${venueId}/onboarding`)
  const [data, uploadPage, proposals] = await Promise.all([
    caller.portal.getOnboardingJourney({ venueId }),
    caller.intakeUpload.list({ venueId, limit: 50 }),
    caller.intake.listProposals({ venueId, limit: 50 }),
  ])
  return (
    <RemoteOnboardingJourney
      data={data}
      uploads={uploadPage.items}
      nextCursor={uploadPage.nextCursor}
      proposals={proposals}
    />
  )
}
