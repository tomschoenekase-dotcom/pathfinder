import Link from 'next/link'

import { DeploymentManifestReview } from '../../../../../../../../components/admin/DeploymentManifestReview'

export default async function DeploymentManifestReviewPage({
  params,
}: {
  params: Promise<{ tenantId: string; venueId: string }>
}) {
  const { tenantId, venueId } = await params
  return (
    <div className="space-y-5">
      <DeploymentManifestReview tenantId={tenantId} venueId={venueId} />
      <aside
        className="rounded-2xl border border-pf-light bg-white p-5"
        aria-label="Native FULL handoff"
      >
        <h2 className="font-semibold text-pf-deep">NATIVE_CORE_V1 FULL workflow</h2>
        <p className="mt-1 text-sm text-pf-deep/75">
          Native FULL releases use separate persisted review and lifecycle evidence. They never use
          compatibility VenuePackage controls.
        </p>
        <Link
          href={`/admin/clients/${tenantId}/venues/${venueId}/native-releases`}
          className="mt-3 inline-flex min-h-11 items-center font-semibold text-pf-primary underline"
        >
          Open native FULL releases
        </Link>
      </aside>
    </div>
  )
}
