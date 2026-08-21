import { AdminBillingPortfolio } from '../../../../components/admin/AdminBillingPortfolio'
import { createAdminCaller } from '../../../../lib/admin-caller'

export const dynamic = 'force-dynamic'

export default async function BillingPortfolioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const query = await searchParams
  const search = query.search?.trim() ?? ''
  const attentionOnly = query.attention === '1'
  const caller = await createAdminCaller()
  const data = await caller.admin.listBillingPortfolio({
    ...(search ? { search } : {}),
    attentionOnly,
    limit: 200,
  })
  return <AdminBillingPortfolio data={data} search={search} attentionOnly={attentionOnly} />
}
