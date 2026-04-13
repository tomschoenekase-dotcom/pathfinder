import { publicProcedure } from './trpc'
import { router } from './core'
import { adminRouter } from './routers/admin/_admin'
import { analyticsRouter } from './routers/analytics'
import { chatRouter } from './routers/chat'
import { operationalUpdateRouter } from './routers/operational-update'
import { placeRouter } from './routers/place'
import { venueRouter } from './routers/venue'

export const appRouter = router({
  admin: adminRouter,
  analytics: analyticsRouter,
  chat: chatRouter,
  operationalUpdate: operationalUpdateRouter,
  venue: venueRouter,
  place: placeRouter,
  health: publicProcedure.query(() => ({
    ok: true,
    scope: 'public',
  })),
})

export type AppRouter = typeof appRouter
