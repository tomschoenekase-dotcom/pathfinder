import { appRouter, createTRPCContext } from '@pathfinder/api'

import { DashboardOverview } from '../../components/DashboardOverview'

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/'),
  })

  return appRouter.createCaller(ctx)
}

export default async function DashboardIndexPage() {
  const caller = await createCaller()
  const venues = await caller.venue.list()
  type VenueItem = (typeof venues)[number]
  const venueDetails = await Promise.all(
    venues.map((venue: VenueItem) => caller.venue.getById({ id: venue.id })),
  )

  const stats = {
    activeAlerts: 0,
    sessionsThisWeek: 0,
    totalPlaces: venueDetails.reduce(
      (sum: number, venue: (typeof venueDetails)[number]) => sum + venue._count.places,
      0,
    ),
    venues: venues.length,
  }

  return <DashboardOverview stats={stats} />
}
