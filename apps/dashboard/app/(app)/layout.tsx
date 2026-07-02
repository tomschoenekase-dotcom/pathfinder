export const dynamic = 'force-dynamic'

import type { ReactNode } from 'react'
import { auth } from '@clerk/nextjs/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { DashboardShell } from '../../components/DashboardShell'
import { createDashboardCaller } from '../../lib/server-caller'

type AppLayoutProps = {
  children: ReactNode
}

export default async function DashboardAppLayout({ children }: AppLayoutProps) {
  const { userId, orgId, sessionClaims } = await auth()

  if (!userId) {
    redirect('/sign-in')
  }

  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  const adminTenantOverride = (await cookies()).get('pf_admin_tenant')?.value
  const effectiveOrgId = orgId ?? (isPlatformAdmin ? adminTenantOverride : null)

  if (!effectiveOrgId) {
    redirect('/onboarding')
  }

  let impersonatedTenantName: string | undefined
  if (isPlatformAdmin && adminTenantOverride) {
    const caller = await createDashboardCaller('/')
    const { tenant } = await caller.tenant.getSettings()
    impersonatedTenantName = tenant.name
  }

  return (
    <DashboardShell {...(impersonatedTenantName !== undefined ? { impersonatedTenantName } : {})}>
      {children}
    </DashboardShell>
  )
}
