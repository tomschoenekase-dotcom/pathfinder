import { TRPCError } from '@trpc/server'

import { isCrmFeatureAvailable } from '@pathfinder/config/feature-flags'

import { t } from '../core'

/** Server-side route boundary; hiding dashboard navigation is not authorization. */
export const requireCrmProspectOutreach = t.middleware(async ({ next }) => {
  if (!isCrmFeatureAvailable('prospectOutreach', 'platform-admin')) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Prospect outreach is not enabled' })
  }
  return next()
})
