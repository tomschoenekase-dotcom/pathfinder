import { cache } from 'react'

import { appRouter, createTRPCContext } from '@pathfinder/api'

// One admitted lookup per server render, shared by metadata, layout, and page.
export const getPublicVenue = cache(async (venueSlug: string) => {
  const ctx = await createTRPCContext({
    req: new Request('https://pathfinder.local/public-venue'),
  })

  return appRouter.createCaller(ctx).venue.getBySlug({ slug: venueSlug })
})
