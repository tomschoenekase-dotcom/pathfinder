import { withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { readOperationsReadiness } from '../../operations-readiness'
import { adminProcedure } from '../../trpc'

export const adminOperationsReadinessRouter = router({
  operationsReadiness: adminProcedure.query(() =>
    withTenantIsolationBypass(() => readOperationsReadiness()),
  ),
})
