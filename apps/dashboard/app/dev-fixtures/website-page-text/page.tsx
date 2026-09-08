import { notFound } from 'next/navigation'

import { WebsitePageTextReader } from '../../../components/admin/WebsitePageTextReader'
import { WebsiteSourceDiscoveryPanel } from '../../../components/admin/WebsiteSourceDiscoveryPanel'
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
          <WebsiteSourceDiscoveryPanel
            review={{
              receiptId: 'fixture-pdf-policy-2',
              status: 'RECORDED',
              sourceHost: 'greenhouse.example',
              inventory: {
                policyVersion: 2,
                observedAt: '2026-09-08T12:00:00.000Z',
                omittedCount: 0,
                items: [
                  {
                    url: 'https://greenhouse.example/',
                    parentUrl: null,
                    depth: 0,
                    observedAt: '2026-09-08T12:00:00.000Z',
                    disposition: 'FETCHED_TEXT',
                    contentType: 'text/html',
                    byteSize: 2400,
                    exactByteHash: '1'.repeat(64),
                  },
                  {
                    url: 'https://greenhouse.example/events-guide.pdf',
                    parentUrl: 'https://greenhouse.example/',
                    depth: 1,
                    observedAt: '2026-09-08T12:00:01.000Z',
                    disposition: 'PDF_TEXT_EXTRACTED',
                    contentType: 'application/pdf',
                    byteSize: 92000,
                    exactByteHash: '2'.repeat(64),
                  },
                  {
                    url: 'https://greenhouse.example/private-guide.pdf',
                    parentUrl: 'https://greenhouse.example/',
                    depth: 1,
                    observedAt: '2026-09-08T12:00:02.000Z',
                    disposition: 'PDF_EXTRACTION_FAILED',
                    contentType: 'application/pdf',
                    byteSize: 81000,
                    exactByteHash: '3'.repeat(64),
                    extractionFailureCode: 'PDF_PASSWORD_REQUIRED',
                  },
                  {
                    url: 'https://greenhouse.example/slow-guide.pdf',
                    parentUrl: 'https://greenhouse.example/',
                    depth: 1,
                    observedAt: '2026-09-08T12:00:03.000Z',
                    disposition: 'PDF_EXTRACTION_FAILED',
                    contentType: 'application/pdf',
                    byteSize: 77000,
                    exactByteHash: '4'.repeat(64),
                    extractionFailureCode: 'PDF_EXTRACTION_TIMEOUT',
                  },
                  {
                    url: 'https://greenhouse.example/deferred',
                    parentUrl: 'https://greenhouse.example/',
                    depth: 1,
                    observedAt: '2026-09-08T12:00:04.000Z',
                    disposition: 'TIME_LIMIT',
                  },
                ],
              },
            }}
          />
          <WebsiteSourceDiscoveryPanel
            review={{
              receiptId: 'fixture-pdf-policy-1',
              status: 'RECORDED',
              sourceHost: 'legacy.greenhouse.example',
              inventory: {
                policyVersion: 1,
                observedAt: '2026-08-01T12:00:00.000Z',
                omittedCount: 0,
                items: [
                  {
                    url: 'https://legacy.greenhouse.example/guide.pdf',
                    parentUrl: null,
                    depth: 0,
                    observedAt: '2026-08-01T12:00:00.000Z',
                    disposition: 'UNSUPPORTED_DOCUMENT',
                  },
                ],
              },
            }}
          />
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
