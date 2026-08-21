export const dynamic = 'force-dynamic'

import type { ReactNode } from 'react'

import { ClientWorkspaceShell } from '../../../../../components/admin/ClientWorkspaceShell'
import { createAdminCaller } from '../../../../../lib/admin-caller'
import { buildGuestChatUrl } from '../../../../../lib/guest-chat-url'

type AdminClientLayoutProps = {
  children: ReactNode
  params: Promise<{ tenantId: string }>
}

export default async function AdminClientLayout({ children, params }: AdminClientLayoutProps) {
  const { tenantId } = await params
  const caller = await createAdminCaller()

  let data: Awaited<ReturnType<Awaited<ReturnType<typeof createAdminCaller>>['admin']['getClient']>>
  try {
    data = await caller.admin.getClient({ tenantId })
  } catch {
    return <>{children}</>
  }

  return (
    <ClientWorkspaceShell
      client={{
        id: data.tenant.id,
        name: data.tenant.name,
        slug: data.tenant.slug,
        status: data.tenant.status,
      }}
      venues={data.venues.map((venue) => ({
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        isActive: venue.isActive,
        guestUrl: buildGuestChatUrl(process.env.NEXT_PUBLIC_WEB_URL, venue.slug, {
          allowLoopbackHttp: process.env.NODE_ENV !== 'production',
        }),
      }))}
      billingAvailable={process.env.STRIPE_BILLING_UI_ENABLED === 'true'}
    >
      {children}
    </ClientWorkspaceShell>
  )
}
