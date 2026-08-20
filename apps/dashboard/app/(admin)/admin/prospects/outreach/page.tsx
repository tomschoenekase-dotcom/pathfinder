import { notFound } from 'next/navigation'

import { isCrmFeatureAvailable } from '@pathfinder/config/feature-flags'

import { ProspectOutreachCenter } from '../../../../../components/admin/ProspectOutreachCenter'

export const dynamic = 'force-dynamic'

export default function ProspectOutreachPage() {
  if (!isCrmFeatureAvailable('prospectOutreach', 'platform-admin')) notFound()
  return <ProspectOutreachCenter />
}
