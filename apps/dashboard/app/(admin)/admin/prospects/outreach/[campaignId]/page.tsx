import { ProspectCampaignWorkbench } from '../../../../../../components/admin/ProspectCampaignWorkbench'

export const dynamic = 'force-dynamic'

export default async function ProspectCampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>
}) {
  const { campaignId } = await params
  return <ProspectCampaignWorkbench campaignId={campaignId} />
}
