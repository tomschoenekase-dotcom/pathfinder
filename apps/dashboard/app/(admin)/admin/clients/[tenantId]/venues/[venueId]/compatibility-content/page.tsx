export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { LegacyContentManager } from '../../../../../../../../components/admin/LegacyContentManager'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type Props = { params: Promise<{ tenantId: string; venueId: string }> }

export default async function CompatibilityContentPage({ params }: Props) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()
  const result = await caller.admin.listLegacyContent({ tenantId, venueId })

  return (
    <div className="space-y-7">
      <header className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-900">
          Internal compatibility tools
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
          Legacy Place &amp; Knowledge
        </h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/75">
          Platform-admin maintenance for compatibility records only. Client portal users cannot
          access these controls. Prefer{' '}
          <Link
            href={`/admin/clients/${tenantId}/venues/${venueId}/content`}
            className="font-semibold text-pf-primary underline underline-offset-2"
          >
            Universal content
          </Link>{' '}
          for new normalized modules.
        </p>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-semibold text-pf-deep">Client scope</dt>
            <dd className="text-pf-deep/75">
              {result.scope.tenant.name} · {result.scope.tenant.id}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-pf-deep">Venue scope</dt>
            <dd className="text-pf-deep/75">
              {result.scope.venue.name} · {result.scope.venue.slug}
            </dd>
          </div>
        </dl>
      </header>

      <LegacyContentManager
        tenantId={tenantId}
        venueId={venueId}
        places={result.places}
        knowledgeEntries={result.knowledgeEntries}
      />
    </div>
  )
}
