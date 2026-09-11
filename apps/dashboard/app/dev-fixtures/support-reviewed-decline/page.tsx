export const metadata = { title: 'Reviewed support declines - Torchiko' }

import { notFound } from 'next/navigation'

import { SupportReviewedDeclineFixtureClient } from './FixtureClient'

export default function SupportReviewedDeclineFixturePage() {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1' ||
    process.env.RUN_SUPPORT_REVIEWED_DECLINE_BROWSER_INTEGRATION !== '1'
  )
    notFound()
  return <SupportReviewedDeclineFixtureClient />
}
