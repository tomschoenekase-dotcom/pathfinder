import { DeploymentManifestReview } from '../../../../../../../../components/admin/DeploymentManifestReview'

export default async function DeploymentManifestReviewPage({
  params,
}: {
  params: Promise<{ tenantId: string; venueId: string }>
}) {
  const { tenantId, venueId } = await params
  return <DeploymentManifestReview tenantId={tenantId} venueId={venueId} />
}
