import { publicProcedure } from './trpc'
import { router } from './core'
import { adminRouter } from './routers/admin/_admin'
import { analyticsRouter } from './routers/analytics'
import { chatRouter } from './routers/chat'
import { engagementQuestionRouter } from './routers/engagement-question'
import { knowledgeRouter } from './routers/knowledge'
import { operationalUpdateRouter } from './routers/operational-update'
import { placeRouter } from './routers/place'
import { tenantRouter } from './routers/tenant'
import { venueRouter } from './routers/venue'

export const appRouter = router({
  admin: adminRouter,
  analytics: analyticsRouter,
  chat: chatRouter,
  engagementQuestion: engagementQuestionRouter,
  knowledge: knowledgeRouter,
  operationalUpdate: operationalUpdateRouter,
  tenant: tenantRouter,
  venue: venueRouter,
  place: placeRouter,
  health: publicProcedure.query(() => ({
    ok: true,
    scope: 'public',
  })),
})

export type AppRouter = typeof appRouter
