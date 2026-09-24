import { notFound } from 'next/navigation'
import Link from 'next/link'
import { isCrmFeatureAvailable } from '@pathfinder/config/feature-flags'
import { ProspectOutreachCenter } from '../../../../../components/admin/ProspectOutreachCenter'
export const dynamic = 'force-dynamic'
export default function ProspectOutreachPage() {
  if (!isCrmFeatureAvailable('prospectOutreach', 'platform-admin')) notFound()
  return (
    <>
      <div className="px-6 pt-4">
        <Link className="text-sm underline" href="/admin/prospects/preparation">
          Open no-send preparation groups and exact review
        </Link>
      </div>
      <ProspectOutreachCenter />
    </>
  )
}
