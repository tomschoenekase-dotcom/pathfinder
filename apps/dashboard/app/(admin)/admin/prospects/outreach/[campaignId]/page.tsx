import { notFound } from 'next/navigation'

import { isCrmFeatureAvailable } from '@pathfinder/config/feature-flags'

import { ProspectCampaignWorkbench } from '../../../../../../components/admin/ProspectCampaignWorkbench'

export const dynamic = 'force-dynamic'

export default async function ProspectCampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>
}) {
  if (!isCrmFeatureAvailable('prospectOutreach', 'platform-admin')) notFound()
  const { campaignId } = await params
  return <ProspectCampaignWorkbench campaignId={campaignId} />
}
