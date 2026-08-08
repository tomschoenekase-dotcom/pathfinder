import { db, setContentVersionContext } from '@pathfinder/db'

import { t } from '../core'

/**
 * Keeps the authenticated actor marker and the domain write on the same
 * database transaction. PostgreSQL content-history triggers read the marker
 * with transaction-local scope, so pooled connections cannot leak identity.
 */
export const withContentVersionActor = t.middleware(async ({ ctx, next }) => {
  if (ctx.session.userId === null) return next()

  return ctx.db.$transaction(async (tx) => {
    await setContentVersionContext(tx, { actorId: ctx.session.userId! })
    return next({
      ctx: {
        ...ctx,
        db: tx as unknown as typeof db,
      },
    })
  })
})
