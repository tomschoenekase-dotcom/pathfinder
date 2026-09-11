import { notFound } from 'next/navigation'
import { SupportDuplicateReviewFixture } from './FixtureClient'
export const metadata = { title: 'Support duplicate review - Torchiko' }
export default function SupportDuplicateReviewFixturePage() {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  return <SupportDuplicateReviewFixture />
}
