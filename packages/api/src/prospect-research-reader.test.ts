import { describe, expect, it } from 'vitest'
import { assertLocalProspectResearchEnvironment } from './prospect-research-reader'

const env = {
  NODE_ENV: 'development',
  TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED: '1',
  DATABASE_URL:
    'postgresql://local:local@127.0.0.1:58617/pathfinder_disposable_crm_research_20260919',
}
describe('retained local CRM adapter authority', () => {
  it('allows only the explicitly enabled exact retained research target', () => {
    expect(() => assertLocalProspectResearchEnvironment(env)).not.toThrow()
    for (const next of [
      { ...env, NODE_ENV: 'production' },
      { ...env, NODE_ENV: 'test' },
      { ...env, TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED: '' },
      { ...env, DATABASE_URL: env.DATABASE_URL.replace('58617', '5432') },
      { ...env, DATABASE_URL: env.DATABASE_URL.replace('20260919', '20260920') },
      { ...env, DATABASE_URL: env.DATABASE_URL.replace('127.0.0.1', 'remote.example') },
      { ...env, DATABASE_URL: `${env.DATABASE_URL}?host=remote.example` },
      { ...env, DIRECT_DATABASE_URL: 'postgresql://remote.example/production' },
      { ...env, APP_ENV: 'production' },
    ])
      expect(() => assertLocalProspectResearchEnvironment(next)).toThrow()
  })
})
