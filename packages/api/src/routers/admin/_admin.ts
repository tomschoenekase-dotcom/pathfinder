import { adminProcedure } from '../../trpc'
import { router } from '../../core'

export const adminRouter = router({
  ping: adminProcedure.query(() => ({
    ok: true,
    scope: 'admin',
  })),
})
