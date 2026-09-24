import { describe, expect, it } from 'vitest'
import { assertLocalChicagoIntelligenceEnvironment } from './chicago-intelligence-local'

const env = {
  NODE_ENV: 'development',
  TORCHIKO_CHICAGO_FIXTURE_ENABLED: '1',
  DATABASE_URL:
    'postgresql://fixture:fixture@127.0.0.1:58617/pathfinder_disposable_chicago_intelligence_20260922',
}
describe('Chicago preview isolated authority', () => {
  it('requires a separate explicit opt-in for the exact retained local CRM and never accepts another database', () => {
    const retained = {
      ...env,
      DATABASE_URL: env.DATABASE_URL.replace(
        'pathfinder_disposable_chicago_intelligence_20260922',
        'pathfinder_disposable_crm_research_20260919',
      ),
    }
    expect(() => assertLocalChicagoIntelligenceEnvironment(retained)).toThrow()
    expect(() =>
      assertLocalChicagoIntelligenceEnvironment({
        ...retained,
        TORCHIKO_CHICAGO_RETAINED_LOCAL_ENABLED: '1',
      }),
    ).not.toThrow()
    expect(() =>
      assertLocalChicagoIntelligenceEnvironment({
        ...retained,
        TORCHIKO_CHICAGO_RETAINED_LOCAL_ENABLED: '1',
        NODE_ENV: 'production',
      }),
    ).toThrow()
    expect(() =>
      assertLocalChicagoIntelligenceEnvironment({
        ...retained,
        TORCHIKO_CHICAGO_RETAINED_LOCAL_ENABLED: '1',
        DATABASE_URL: retained.DATABASE_URL.replace('crm_research_20260919', 'unrelated'),
      }),
    ).toThrow()
  })
  it('accepts only explicitly enabled exact local disposable target', () => {
    expect(() => assertLocalChicagoIntelligenceEnvironment(env)).not.toThrow()
    expect(() =>
      assertLocalChicagoIntelligenceEnvironment({ ...env, DIRECT_DATABASE_URL: env.DATABASE_URL }),
    ).not.toThrow()
    for (const changed of [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'test' },
      { TORCHIKO_CHICAGO_FIXTURE_ENABLED: '0' },
      { DATABASE_URL: env.DATABASE_URL.replace('127.0.0.1', 'localhost') },
      { DATABASE_URL: env.DATABASE_URL.replace('127.0.0.1', 'remote.example') },
      { DATABASE_URL: env.DATABASE_URL.replace('58617', '5432') },
      { DATABASE_URL: env.DATABASE_URL.replace('20260922', '20260923') },
      { DATABASE_URL: `${env.DATABASE_URL}?host=remote.example` },
      { DATABASE_URL: `${env.DATABASE_URL}#other` },
      { DATABASE_URL: 'invalid' },
      { DIRECT_DATABASE_URL: 'postgresql://remote.example/production' },
      { APP_ENV: 'production' },
      { DEPLOYMENT_ENV: 'production' },
      { VERCEL_ENV: 'production' },
      { RAILWAY_ENVIRONMENT_NAME: 'production' },
    ])
      expect(() => assertLocalChicagoIntelligenceEnvironment({ ...env, ...changed })).toThrow()
  })
})
