export const dynamic = 'force-dynamic'

import type { ReactNode } from 'react'
import { auth } from '@clerk/nextjs/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { DashboardShell } from '../../components/DashboardShell'
import { createDashboardCaller } from '../../lib/server-caller'
import { TRPCProvider } from '../../lib/trpc'

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
  let weeklyReportsAvailable = false
  let paymentAvailable = false
  const caller = await createDashboardCaller('/')
  if (isPlatformAdmin && adminTenantOverride) {
    const { tenant } = await caller.tenant.getSettings()
    impersonatedTenantName = tenant.name
  }
  try {
    const availability = await caller.analytics.getWeeklyReportAvailability()
    weeklyReportsAvailable = availability.enabledVenueIds.length > 0
  } catch {
    // Report navigation is capability-gated. An unavailable check must fail closed.
  }
  if (process.env.STRIPE_BILLING_UI_ENABLED === 'true') {
    try {
      const billing = await caller.billing.overview()
      paymentAvailable = billing.enabled
    } catch {
      // Billing navigation is protected by both the environment kill switch and tenant flag.
    }
  }

  return (
    <TRPCProvider scopeKey={`tenant:${effectiveOrgId}`}>
      <DashboardShell
        weeklyReportsAvailable={weeklyReportsAvailable}
        paymentAvailable={paymentAvailable}
        {...(impersonatedTenantName !== undefined ? { impersonatedTenantName } : {})}
      >
        {children}
      </DashboardShell>
    </TRPCProvider>
  )
}
