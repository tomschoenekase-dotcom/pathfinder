import { notFound } from 'next/navigation'
import { isCrmFeatureAvailable } from '@pathfinder/config/feature-flags'
import { ProspectOutreachCenter } from '../../../../../components/admin/ProspectOutreachCenter'
export const dynamic = 'force-dynamic'
export default function ProspectOutreachPage() {
  if (!isCrmFeatureAvailable('prospectOutreach', 'platform-admin')) notFound()
  return (
    <>
      <div className="px-6 pt-4">
        <a className="text-sm underline" href="/admin/prospects/preparation">
          Open no-send preparation groups and exact review
        </a>
      </div>
      <ProspectOutreachCenter />
    </>
  )
}
