import { isCrmFeatureAvailable } from '@pathfinder/config/feature-flags'
import Link from 'next/link'

import { ProspectDirectory } from '../../../../components/admin/ProspectDirectory'
import { createAdminCaller } from '../../../../lib/admin-caller'

export const dynamic = 'force-dynamic'

export default async function ProspectDirectoryPage() {
  const caller = await createAdminCaller()
  const territories = await caller.admin.listProspectTerritories()
  return (
    <>
      <div className="px-6 pt-4">
        <Link href="/admin/prospects/preparation" className="text-sm underline">
          Outreach preparation and exact group review
        </Link>
      </div>
      <ProspectDirectory
        defaultScope="chicago"
        outreachAvailable={isCrmFeatureAvailable('prospectOutreach', 'platform-admin')}
        territories={territories}
      />
    </>
  )
}
