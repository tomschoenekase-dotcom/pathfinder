export const dynamic = 'force-dynamic'

import type { ReactNode } from 'react'

import { AdminTab } from '../../../../../components/admin/AdminTab'

type AdminClientLayoutProps = {
  children: ReactNode
  params: Promise<{ tenantId: string }>
}

export default async function AdminClientLayout({ children, params }: AdminClientLayoutProps) {
  const { tenantId } = await params

  return (
    <div className="space-y-6">
      <nav className="flex gap-1 border-b border-pf-light pb-0" aria-label="Client sections">
        <AdminTab href={`/admin/clients/${tenantId}`} label="Overview" />
        <AdminTab href={`/admin/clients/${tenantId}/analytics`} label="Analytics" />
      </nav>
      {children}
    </div>
  )
}
