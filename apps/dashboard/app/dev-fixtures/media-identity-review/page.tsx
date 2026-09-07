import { notFound } from 'next/navigation'
import { TRPCProvider } from '../../../lib/trpc'
import { FixtureClient } from './FixtureClient'

export const metadata = { title: 'Media identity review fixture' }

export default function MediaIdentityReviewFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <TRPCProvider scopeKey="media-identity-review-fixture">
      <main className="min-h-screen bg-pf-cream px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <h1 className="mb-4 text-sm font-medium text-pf-deep">
            Synthetic identity review fixture
          </h1>
          <FixtureClient />
        </div>
      </main>
    </TRPCProvider>
  )
}
