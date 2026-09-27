import { notFound } from 'next/navigation'

import { ProspectSizeProposalReview } from '../../../components/admin/ProspectSizeProposalReview'
import { TRPCProvider } from '../../../lib/trpc'

export const metadata = { title: 'Prospect size review fixture' }

export default function ProspectSizeReviewFixturePage() {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  return (
    <TRPCProvider scopeKey="prospect-size-review-fixture">
      <ProspectSizeProposalReview />
    </TRPCProvider>
  )
}
