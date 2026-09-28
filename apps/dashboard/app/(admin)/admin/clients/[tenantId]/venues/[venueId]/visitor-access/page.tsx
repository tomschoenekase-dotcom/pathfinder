export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { buildVenueAccessArtifacts } from '@pathfinder/contracts/venue-access-artifacts'
import { getChatPalette } from '@pathfinder/ui/theme'

import { AdminVenueDistributionPanel } from '../../../../../../../../components/admin/AdminVenueDistributionPanel'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type Props = { params: Promise<{ tenantId: string; venueId: string }> }

export default async function AdminVenueVisitorAccessPage({ params }: Props) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()
  try {
    const data = await caller.admin.venueDistribution.get({ tenantId, venueId })
    const appBackground = getChatPalette(data.venue.chatTheme, data.venue.chatAccentColor).bg
    const artifacts = buildVenueAccessArtifacts(process.env.NEXT_PUBLIC_WEB_URL, data.venue.slug, {
      appBackground,
    })
    const webOrigin = process.env.NEXT_PUBLIC_WEB_URL
    const previewUrl = artifacts?.publicUrl ?? null
    return (
      <main className="space-y-7">
        <header className="space-y-3">
          <Link
            href={`/admin/clients/${tenantId}/venues/${venueId}`}
            className="inline-flex min-h-10 items-center text-sm font-medium text-pf-primary hover:text-pf-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary"
          >
            ← Venue overview
          </Link>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Visitor access</h1>
            <p className="mt-2 text-sm leading-6 text-pf-deep/70">
              {data.venue.name} · Review visitor entry points, website framing origins, app access,
              and recent sessions.
            </p>
          </div>
          {!webOrigin ? (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              The public web origin is missing. Access settings are available, but visitor links
              cannot be generated.
            </p>
          ) : null}
        </header>
        <AdminVenueDistributionPanel
          tenantId={tenantId}
          venueId={venueId}
          website={data.website}
          app={data.app}
          revision={data.revision}
          origins={data.origins.map((origin) => ({
            ...origin,
            addedAt: origin.addedAt.toISOString(),
            revokedAt: origin.revokedAt?.toISOString() ?? null,
          }))}
          sessions30d={data.sessions30d}
          publicPlaces={data.publicPlaces}
          appHandBacks30d={data.appHandBacks30d}
          previewUrl={previewUrl}
          proposals={data.proposals.map((proposal) => ({
            approvalRequestId: proposal.approvalRequestId,
            reason: proposal.reason,
            createdAt: proposal.createdAt.toISOString(),
            change: proposal.change,
            expectedRevision: proposal.expectedRevision,
          }))}
          artifacts={
            artifacts
              ? [
                  { label: 'Public visitor URL', value: artifacts.publicUrl },
                  { label: 'QR entry URL', value: artifacts.qrUrl },
                  { label: 'Launcher snippet', value: artifacts.launcherSnippet },
                  { label: 'Inline snippet', value: artifacts.inlineSnippet },
                  { label: 'App URL', value: artifacts.appUrl },
                  { label: 'Compact app URL', value: artifacts.compactAppUrl },
                  ...(artifacts.appBackground
                    ? [{ label: 'App background color', value: artifacts.appBackground }]
                    : []),
                ]
              : []
          }
        />
      </main>
    )
  } catch {
    return (
      <section className="rounded-2xl border border-rose-200 bg-white p-7" role="alert">
        <h1 className="text-2xl font-semibold text-pf-deep">Visitor access could not be loaded</h1>
        <p className="mt-2 text-sm leading-6 text-pf-deep/75">
          Confirm this client and venue scope, then reload the page.
        </p>
        <Link
          href={`/admin/clients/${tenantId}/venues/${venueId}`}
          className="mt-4 inline-flex min-h-10 items-center text-sm font-semibold text-pf-primary"
        >
          Return to venue overview
        </Link>
      </section>
    )
  }
}
