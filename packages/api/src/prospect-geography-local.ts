// Opt-in retained-loopback transport. Never creates a human or grants approval authority.
import { withTenantIsolationBypass, proposeProspectGeography, listProspectGeographyProposals } from '@pathfinder/db'
import { assertLocalProspectResearchEnvironment, createLocalProspectResearchReader } from './prospect-research-reader'

export function createLocalProspectGeographyClient() {
  assertLocalProspectResearchEnvironment(process.env)
  if (['APP_ENV','DEPLOYMENT_ENV','VERCEL_ENV','RAILWAY_ENVIRONMENT_NAME'].some(key=>process.env[key]?.toLowerCase()==='production'))
    throw new Error('Local geography client is disabled in hosted production')
  const reader = createLocalProspectResearchReader()
  const actor = { id: 'local-geography-proposal-client', runId: 'local-geography-proposal-client',
    type: 'SYSTEM' as const, scope: { mode: 'ALL' as const }, capabilities: ['prospects.read','prospects.maintain'] }
  async function execute<T>(work:()=>Promise<T>){ return withTenantIsolationBypass(()=>work()) }
  return {
    territories: reader.researchTerritories,
    geography: reader.physicalGeography,
    records: reader.geographyHolds,
    proposals: (input:unknown)=>execute(()=>listProspectGeographyProposals(input,actor)),
    propose: (input:unknown)=>execute(()=>proposeProspectGeography(input,actor)),
    // No assign, accept, reject, invalidate, send, credential or general RPC forwarding.
  }
}
