import { isCrmFeatureAvailable } from '@pathfinder/config/feature-flags'

import { ProspectDirectory } from '../../../../components/admin/ProspectDirectory'

export const dynamic = 'force-dynamic'

export default function ProspectDirectoryPage() {
  return (
    <ProspectDirectory
      outreachAvailable={isCrmFeatureAvailable('prospectOutreach', 'platform-admin')}
    />
  )
}
