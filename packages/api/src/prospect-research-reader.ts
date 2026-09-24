// Read-only development adapter for a retained, isolated local research database.
// Production CRM requests continue to use Clerk-backed adminProcedure context.
import { db } from '@pathfinder/db'
import { adminProspectCrmDirectoryRouter } from './routers/admin/prospect-crm-directory'
import { adminProspectCrmCoreRouter } from './routers/admin/prospect-crm-core'
import { adminProspectCrmTerritoriesRouter } from './routers/admin/prospect-crm-territories'
import { adminProspectCrmIntelligenceRouter } from './routers/admin/prospect-crm-intelligence'

export function assertLocalProspectResearchEnvironment(env: Record<string, string | undefined>) {
  if (env.NODE_ENV !== 'development' || env.TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED !== '1') {
    throw new Error('Local research preview is disabled')
  }
  const target = new URL(env.DATABASE_URL ?? '')
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.port !== '58617' ||
    target.search ||
    target.hash ||
    target.pathname !== '/pathfinder_disposable_crm_research_20260919'
  )
    throw new Error('Local research preview requires an isolated loopback research database')
  if (env.DIRECT_DATABASE_URL && env.DIRECT_DATABASE_URL !== env.DATABASE_URL) {
    throw new Error('Local research preview cannot use another direct database target')
  }
  if (env.APP_ENV === 'production' || env.DEPLOYMENT_ENV === 'production') {
    throw new Error('Local research preview is disabled in a production deployment')
  }
}

export function createLocalProspectResearchReader() {
  assertLocalProspectResearchEnvironment(process.env)
  const context = {
    db,
    headers: new Headers(),
    session: {
      userId: 'local-research-read-only',
      activeTenantId: null,
      role: null,
      isPlatformAdmin: true,
    },
  }
  const directory = adminProspectCrmDirectoryRouter.createCaller(context)
  const core = adminProspectCrmCoreRouter.createCaller(context)
  const territories = adminProspectCrmTerritoriesRouter.createCaller(context)
  const intelligence = adminProspectCrmIntelligenceRouter.createCaller(context)
  // Expose reads only. No mutation, campaign, or delivery capability is reachable.
  return {
    list: directory.listProspects,
    detail: core.getProspect,
    territories: territories.listProspectTerritories,
    geographySummary: territories.getProspectTerritoryModel,
    researchTerritories: territories.listResearchTerritories,
    geographyHolds: territories.listProspectGeographyHolds,
    physicalGeography: territories.getProspectPhysicalGeography,
    intelligence: intelligence.getProspectIntelligence,
  }
}
