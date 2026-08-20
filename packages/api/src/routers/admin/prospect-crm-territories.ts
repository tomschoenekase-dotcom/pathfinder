import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminProspectCrmTerritoriesRouter = router({
  listProspectTerritories: adminProcedure.query(() =>
    withTenantIsolationBypass(() =>
      db.prospectTerritory.findMany({
        where: { archivedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, code: true, name: true, region: true },
      }),
    ),
  ),
})
