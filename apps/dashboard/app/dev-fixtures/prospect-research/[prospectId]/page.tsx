import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { createLocalProspectResearchReader } from '@pathfinder/api/prospect-research-reader'
import { localFirstSendRehearsalEnabled } from '@pathfinder/db'

import { ProspectDetailView } from '../../../../components/admin/ProspectDetailView'
import { isLocalProspectResearchRequest } from '../../../../lib/local-prospect-research-boundary'
import { TRPCProvider } from '../../../../lib/trpc'

export const dynamic = 'force-dynamic'
export default async function LocalProspectResearchDetail({
  params,
  searchParams,
}: {
  params: Promise<{ prospectId: string }>
  searchParams: Promise<{ directoryQuery?: string }>
}) {
  if (!isLocalProspectResearchRequest(await headers())) notFound()
  const { prospectId } = await params
  const { directoryQuery } = await searchParams
  if (
    !/^porg_[a-f0-9]{24}$/.test(prospectId) &&
    !(localFirstSendRehearsalEnabled() && /^SYN-CRM-FIRSTSEND-ORG-r\d+$/.test(prospectId))
  )
    notFound()
  const reader = createLocalProspectResearchReader()
  let data
  try {
    data = await Promise.all([
      reader.detail({ organizationId: prospectId }),
      reader.intelligence({ organizationId: prospectId }),
    ])
  } catch {
    notFound()
  }
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-8">
      <div className="mx-auto min-w-0 max-w-7xl">
        <TRPCProvider scopeKey={`local-prospect-research:${prospectId}`}>
          <ProspectDetailView
            prospect={data[0]}
            intelligence={data[1]}
            readOnly
            salesPreparationMode={
              process.env.TORCHIKO_LOCAL_CRM_SALES_ENABLED === '1' ? 'local' : undefined
            }
            directoryHref="/dev-fixtures/prospect-research"
            directoryQuery={directoryQuery}
          />
        </TRPCProvider>
      </div>
    </main>
  )
}
