// Local acceptance adapter only. Hosted requests keep the normal authenticated admin boundary.
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { adminProspectCrmChicagoRouter } from './routers/admin/prospect-crm-chicago'

export function assertLocalChicagoIntelligenceEnvironment(env: Record<string, string | undefined>) {
  if (env.NODE_ENV !== 'development' || env.TORCHIKO_CHICAGO_FIXTURE_ENABLED !== '1')
    throw new Error('Local Chicago fixture is disabled')
  let target: URL
  try {
    target = new URL(env.DATABASE_URL ?? '')
  } catch {
    throw new Error('Local Chicago fixture requires its exact disposable database')
  }
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    target.hostname !== '127.0.0.1' ||
    target.port !== '58617' ||
    !(
      target.pathname === '/pathfinder_disposable_chicago_intelligence_20260922' ||
      (env.TORCHIKO_CHICAGO_RETAINED_LOCAL_ENABLED === '1' &&
        target.pathname === '/pathfinder_disposable_crm_research_20260919')
    ) ||
    target.search ||
    target.hash
  )
    throw new Error(
      'Local Chicago workspace requires its exact disposable database or explicitly enabled retained local CRM',
    )
  if (env.DIRECT_DATABASE_URL && env.DIRECT_DATABASE_URL !== env.DATABASE_URL)
    throw new Error('Local Chicago fixture cannot use a different direct target')
  if (
    ['APP_ENV', 'DEPLOYMENT_ENV', 'VERCEL_ENV', 'RAILWAY_ENVIRONMENT_NAME'].some(
      (key) => env[key]?.toLowerCase() === 'production',
    )
  )
    throw new Error('Local Chicago fixture is disabled in production deployments')
}

export function createLocalChicagoIntelligenceCaller() {
  assertLocalChicagoIntelligenceEnvironment(process.env)
  const caller = adminProspectCrmChicagoRouter.createCaller({
    db,
    headers: new Headers(),
    session: {
      userId: 'local-chicago-fixture-admin',
      activeTenantId: null,
      role: null,
      isPlatformAdmin: true,
    },
  })
  return {
    list: caller.listChicagoVenues,
    read: caller.getChicagoVenue,
    health: caller.getChicagoHealth,
    add: caller.addChicagoVenue,
    change: caller.changeChicagoVenue,
    duplicate: caller.proposeChicagoDuplicate,
    // Server-page metadata only; not exposed as a general database/RPC transport.
    territoryId: async () =>
      withTenantIsolationBypass(async () => {
        const territory = await db.prospectTerritory.findFirst({
          where: { name: 'Chicago Metro', archivedAt: null },
          select: { id: true },
        })
        if (!territory)
          throw new Error('Import the exact Chicago operating territory before opening the fixture')
        return territory.id
      }),
  }
}
