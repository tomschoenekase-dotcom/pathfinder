import { describe, expect, it } from 'vitest'

import {
  WORKER_EXECUTION_FLAGS,
  resolveWorkerStartupPolicy,
  type WorkerStartupEnvironment,
} from './worker-startup-policy'

const disabled = Object.fromEntries(WORKER_EXECUTION_FLAGS.map((flag) => [flag, 'false']))

describe('worker startup policy', () => {
  it('starts staging in a provider-disabled mode that requires only Redis', () => {
    expect(resolveWorkerStartupPolicy({ RAILWAY_ENVIRONMENT: 'staging' })).toEqual({
      mode: 'provider-disabled',
      requiredEnvironmentKeys: ['REDIS_URL'],
    })
  })

  it('requires every execution flag to be explicit for production workers', () => {
    for (const missing of WORKER_EXECUTION_FLAGS) {
      const environment: WorkerStartupEnvironment = {
        ...disabled,
        RAILWAY_ENVIRONMENT: 'production',
      }
      delete environment[missing]
      expect(() => resolveWorkerStartupPolicy(environment)).toThrow(
        `${missing} must be explicitly set for production workers`,
      )
    }
  })

  it('rejects non-boolean execution flag values before choosing a mode', () => {
    expect(() =>
      resolveWorkerStartupPolicy({
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'yes',
      }),
    ).toThrow('OUTBOUND_PROVIDER_WORKERS_ENABLED must be exactly true or false for workers')
  })

  it('requires provider keys only for an explicitly provider-enabled worker', () => {
    expect(
      resolveWorkerStartupPolicy({
        ...disabled,
        RAILWAY_ENVIRONMENT: 'production',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'true',
      }),
    ).toEqual({
      mode: 'provider-enabled',
      requiredEnvironmentKeys: ['REDIS_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    })
  })

  it('permits a database-backed CRM import runtime while outbound providers stay disabled', () => {
    expect(
      resolveWorkerStartupPolicy({
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
        CRM_BACKGROUND_WORKERS_ENABLED: 'true',
      }),
    ).toEqual({
      mode: 'crm-only',
      requiredEnvironmentKeys: ['REDIS_URL', 'DATABASE_URL', 'DIRECT_DATABASE_URL'],
    })
  })

  it.each(
    WORKER_EXECUTION_FLAGS.filter(
      (flag) =>
        flag !== 'OUTBOUND_PROVIDER_WORKERS_ENABLED' && flag !== 'CRM_BACKGROUND_WORKERS_ENABLED',
    ),
  )('rejects %s when provider workers are disabled', (flag) => {
    expect(() =>
      resolveWorkerStartupPolicy({
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
        [flag]: 'true',
      }),
    ).toThrow(`${flag} cannot be enabled while outbound provider workers are disabled`)
  })
})
