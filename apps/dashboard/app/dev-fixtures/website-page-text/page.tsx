import { notFound } from 'next/navigation'

import { WebsitePageTextReader } from '../../../components/admin/WebsitePageTextReader'
import { TRPCProvider } from '../../../lib/trpc'

export const metadata = { title: 'Retained website text fixture' }

const fixtureEnabled =
  process.env.NODE_ENV === 'development' && process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED === '1'

export default function WebsitePageTextFixture() {
  if (!fixtureEnabled) notFound()
  return (
    <TRPCProvider scopeKey="website-page-text-fixture">
      <main
        data-fixture="website-page-text"
        className="min-h-screen bg-slate-100 px-3 py-6 text-slate-950 sm:px-6 lg:px-10"
      >
        <section className="mx-auto max-w-6xl border border-slate-200 bg-white p-4 sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
            Intake evidence · deterministic fixture
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Website page observations</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
            Synthetic transport for layout and interaction proof. It performs no fetch, mapping,
            approval, or provider call.
          </p>
          <WebsitePageTextReader
            tenantId="fixture-tenant"
            venueId="fixture-venue"
            runId="fixture-run"
            receiptId="968c2e1a-8ece-47ad-98dc-e4bde64872ca"
          />
        </section>
      </main>
    </TRPCProvider>
  )
}
