import { notFound } from 'next/navigation'
import { WebsiteSourceDiscoveryPanel } from '../../../components/admin/WebsiteSourceDiscoveryPanel'

export default function WebsiteSourceDiscoveryFixture() {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  const observedAt = '2026-09-08T08:00:00.000Z'
  const root = 'https://greenhouse.example/'
  return (
    <main className="min-h-screen bg-slate-50 px-3 py-8 text-slate-950 sm:px-8">
      <section className="mx-auto max-w-5xl bg-white p-4 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">
          Intake review · synthetic fixture
        </p>
        <h1 className="mt-2 text-2xl font-semibold">Website sources</h1>
        <WebsiteSourceDiscoveryPanel
          review={{
            receiptId: 'fixture-discovery',
            status: 'RECORDED',
            sourceHost: 'greenhouse.example',
            inventory: {
              policyVersion: 1,
              observedAt,
              omittedCount: 2,
              items: [
                {
                  url: root,
                  parentUrl: null,
                  depth: 0,
                  observedAt,
                  disposition: 'FETCHED_TEXT',
                  byteSize: 2400,
                  exactByteHash: 'a'.repeat(64),
                  contentType: 'text/html',
                },
                {
                  url: `${root}visitor-information`,
                  parentUrl: root,
                  depth: 1,
                  observedAt,
                  disposition: 'FETCHED_TEXT',
                  byteSize: 2400,
                  exactByteHash: 'a'.repeat(64),
                  duplicateOf: root,
                },
                {
                  url: `${root}documents/${'visitor-accessibility-guide-'.repeat(5)}.pdf`,
                  parentUrl: root,
                  depth: 1,
                  observedAt,
                  disposition: 'UNSUPPORTED_DOCUMENT',
                },
                {
                  url: `${root}greenhouse-tour.mp4`,
                  parentUrl: root,
                  depth: 1,
                  observedAt,
                  disposition: 'UNSUPPORTED_VIDEO',
                },
                {
                  url: `${root}site-map.png`,
                  parentUrl: root,
                  depth: 1,
                  observedAt,
                  disposition: 'UNSUPPORTED_IMAGE',
                },
                {
                  url: `${root}private-path`,
                  parentUrl: root,
                  depth: 1,
                  observedAt,
                  disposition: 'ROBOTS_DENIED',
                },
                ...Array.from({ length: 16 }, (_, i) => ({
                  url: `${root}archive/guide-${i}.pdf`,
                  parentUrl: root,
                  depth: 1,
                  observedAt,
                  disposition: 'UNSUPPORTED_DOCUMENT' as const,
                })),
              ],
            },
          }}
        />
      </section>
    </main>
  )
}
