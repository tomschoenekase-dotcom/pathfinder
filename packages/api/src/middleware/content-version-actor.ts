import { db, setContentVersionContext } from '@pathfinder/db'

import { t } from '../core'

/**
 * Keeps the authenticated actor marker and the domain write on the same
 * database transaction. PostgreSQL content-history triggers read the marker
 * with transaction-local scope, so pooled connections cannot leak identity.
 */
export function contentVersionActor(options?: { maxWait: number; timeout: number }) {
  return t.middleware(async ({ ctx, next }) => {
    if (ctx.session.userId === null) return next()

    return ctx.db.$transaction(async (tx) => {
      await setContentVersionContext(tx, { actorId: ctx.session.userId! })
      const result = await next({
        ctx: {
          ...ctx,
          db: tx as unknown as typeof db,
        },
      })
      // tRPC returns failed middleware results instead of rejecting them. A failed domain write
      // must reject the transaction callback so its earlier content/history writes roll back.
      if (!result.ok) throw result.error
      return result
    }, options)
  })
}

export const withContentVersionActor = contentVersionActor()
