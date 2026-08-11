import { publicProcedure } from './trpc'
import { router } from './core'
import { adminRouter } from './routers/admin/_admin'
import { mediaIngestionRouter } from './routers/admin/media-ingestion'
import { analyticsRouter } from './routers/analytics'
import { chatRouter } from './routers/chat'
import { contentHistoryRouter } from './routers/content-history'
import { engagementQuestionRouter } from './routers/engagement-question'
import { knowledgeRouter } from './routers/knowledge'
import { operationalUpdateRouter } from './routers/operational-update'
import { placeRouter } from './routers/place'
import { tenantRouter } from './routers/tenant'
import { supportRouter } from './routers/support'
import { venueRouter } from './routers/venue'
import { venuePackageRouter } from './routers/venue-package'

export const appRouter = router({
  admin: adminRouter,
  mediaIngestion: mediaIngestionRouter,
  analytics: analyticsRouter,
  chat: chatRouter,
  contentHistory: contentHistoryRouter,
  engagementQuestion: engagementQuestionRouter,
  knowledge: knowledgeRouter,
  operationalUpdate: operationalUpdateRouter,
  support: supportRouter,
  tenant: tenantRouter,
  venue: venueRouter,
  venuePackage: venuePackageRouter,
  place: placeRouter,
  health: publicProcedure.query(() => ({
    ok: true,
    scope: 'public',
  })),
})

export type AppRouter = typeof appRouter
