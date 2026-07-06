import { auth } from '@clerk/nextjs/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { DashboardOverview } from '../../components/DashboardOverview'
import { createDashboardCaller } from '../../lib/server-caller'

export default async function DashboardIndexPage() {
  const caller = await createDashboardCaller('/')
  const [venues, operationalUpdates, dailyStats] = await Promise.all([
    caller.venue.list(),
    caller.operationalUpdate.list(),
    caller.analytics.getDailyStats({ days: 7 }),
  ])

  const { sessionClaims } = await auth()
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  const adminTenantOverride = (await cookies()).get('pf_admin_tenant')?.value
  let impersonatedTenantName: string | undefined
  if (isPlatformAdmin && adminTenantOverride) {
    const { tenant } = await caller.tenant.getSettings()
    impersonatedTenantName = tenant.name
  }

  if (venues.length === 0) {
    redirect('/onboarding/setup')
  }

  type OperationalUpdateItem = (typeof operationalUpdates)[number]
  type DailyStatItem = (typeof dailyStats)[number]
  const activeAlerts = operationalUpdates.filter(
    (update: OperationalUpdateItem) => update.isActive,
  ).length
  const sessionsThisWeek = dailyStats.reduce((sum: number, row: DailyStatItem) => {
    if (row.metric !== 'sessions') {
      return sum
    }

    return sum + row.value
  }, 0)

  const stats = {
    activeAlerts,
    sessionsThisWeek,
    totalPlaces: venues.reduce((sum: number, venue) => sum + venue._count.places, 0),
    venues: venues.length,
  }
  const firstVenue = venues[0] ?? null
  const webUrl = process.env.NEXT_PUBLIC_WEB_URL ?? null
  const chatUrl = firstVenue && webUrl ? `${webUrl}/${firstVenue.slug}/chat` : null

  return (
    <DashboardOverview
      stats={stats}
      chatUrl={chatUrl}
      {...(impersonatedTenantName !== undefined ? { impersonatedTenantName } : {})}
    />
  )
}
