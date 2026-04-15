import { appRouter, createTRPCContext } from '@pathfinder/api'
import { redirect } from 'next/navigation'

import { DashboardOverview } from '../../components/DashboardOverview'

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/'),
  })

  return appRouter.createCaller(ctx)
}

export default async function DashboardIndexPage() {
  const caller = await createCaller()
  const [venues, operationalUpdates, dailyStats] = await Promise.all([
    caller.venue.list(),
    caller.operationalUpdate.list(),
    caller.analytics.getDailyStats({ days: 7 }),
  ])

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

  return <DashboardOverview stats={stats} />
}
