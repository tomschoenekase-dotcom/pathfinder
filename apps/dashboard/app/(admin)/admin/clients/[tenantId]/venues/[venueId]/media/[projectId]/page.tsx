export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { MediaIngestionProjectDetail } from '../../../../../../../../../components/admin/MediaIngestionProjectDetail'
import { createAdminCaller } from '../../../../../../../../../lib/admin-caller'

export default async function AdminMediaProjectPage({
  params,
}: {
  params: Promise<{ tenantId: string; venueId: string; projectId: string }>
}) {
  const { tenantId, venueId, projectId } = await params
  const caller = await createAdminCaller()
  const project = await caller.mediaIngestion.get({ tenantId, venueId, projectId })

  return (
    <div className="space-y-8">
      <Link
        href={`/admin/clients/${tenantId}/venues/${venueId}/media`}
        className="text-sm font-medium text-pf-primary hover:text-pf-accent"
      >
        ← All media intakes
      </Link>
      <MediaIngestionProjectDetail initialProject={project} />
    </div>
  )
}
