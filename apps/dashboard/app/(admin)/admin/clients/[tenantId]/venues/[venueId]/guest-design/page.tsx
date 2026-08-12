export const dynamic = 'force-dynamic'

import { GuestDesignWorkspace } from '../../../../../../../../components/admin/GuestDesignWorkspace'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type Props = { params: Promise<{ tenantId: string; venueId: string }> }

export default async function GuestDesignPage({ params }: Props) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()

  try {
    const design = await caller.admin.getGuestDesign({ tenantId, venueId })
    return <GuestDesignWorkspace tenantId={tenantId} venueId={venueId} initial={design} />
  } catch {
    return (
      <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
        <h2 className="text-2xl font-semibold text-pf-deep">Guest design could not be loaded</h2>
        <p className="mt-2 text-sm text-pf-deep/75">
          No presentation setting was changed. Confirm the exact client and venue scope, then retry.
        </p>
      </section>
    )
  }
}
