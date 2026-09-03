import { notFound } from 'next/navigation'

import { MediaIngestionWorkbench } from '../../../components/admin/MediaIngestionWorkbench'
import { TRPCProvider } from '../../../lib/trpc'

export default function MediaIngestionVisualFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <TRPCProvider scopeKey="media-ingestion-fixture">
      <main className="min-h-screen bg-pf-cream px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-pf-deep/70">
            Venue Media Lab fixture · provider-dark
          </p>
          <MediaIngestionWorkbench
            tenantId="fixture-tenant"
            venueId="fixture-venue"
            venueName="Great Lakes Discovery Museum"
            initialProjects={[]}
          />
        </div>
      </main>
    </TRPCProvider>
  )
}
