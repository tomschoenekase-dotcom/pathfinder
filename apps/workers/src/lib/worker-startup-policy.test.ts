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
      intakeUploadVerificationEnabled: false,
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
      intakeUploadVerificationEnabled: false,
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
      intakeUploadVerificationEnabled: false,
    })
  })

  it('permits a provider-independent authoritative upload verification runtime', () => {
    expect(
      resolveWorkerStartupPolicy({
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
        INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'true',
      }),
    ).toEqual({
      mode: 'intake-upload-verification-only',
      requiredEnvironmentKeys: [
        'REDIS_URL',
        'DATABASE_URL',
        'DIRECT_DATABASE_URL',
        'STORAGE_BUCKET',
        'STORAGE_REGION',
        'STORAGE_ACCESS_KEY_ID',
        'STORAGE_SECRET_ACCESS_KEY',
        'INTAKE_CLAMAV_HOST',
      ],
      intakeUploadVerificationEnabled: true,
    })
  })

  it('permits an isolated evaluation runtime without enabling unrelated provider queues', () => {
    expect(
      resolveWorkerStartupPolicy({
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
        EVALUATION_RUNNER_ENABLED: 'true',
      }),
    ).toEqual({
      mode: 'evaluation-only',
      requiredEnvironmentKeys: [
        'REDIS_URL',
        'DATABASE_URL',
        'DIRECT_DATABASE_URL',
        'OPENAI_API_KEY',
      ],
      intakeUploadVerificationEnabled: false,
    })
  })

  it('permits the deterministic venue media derivative runtime without provider workers', () => {
    expect(
      resolveWorkerStartupPolicy({
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
        VENUE_MEDIA_DERIVATIVE_WORKERS_ENABLED: 'true',
      }),
    ).toEqual({
      mode: 'venue-media-derivative-only',
      requiredEnvironmentKeys: [
        'REDIS_URL',
        'DATABASE_URL',
        'DIRECT_DATABASE_URL',
        'STORAGE_BUCKET',
        'STORAGE_REGION',
        'STORAGE_ACCESS_KEY_ID',
        'STORAGE_SECRET_ACCESS_KEY',
      ],
      intakeUploadVerificationEnabled: false,
    })
  })

  it('permits the database-backed founder absence observer without provider workers', () => {
    expect(
      resolveWorkerStartupPolicy({
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
        FOUNDER_ABSENCE_OBSERVER_ENABLED: 'true',
      }),
    ).toEqual({
      mode: 'founder-absence-observer-only',
      requiredEnvironmentKeys: ['REDIS_URL', 'DATABASE_URL', 'DIRECT_DATABASE_URL'],
      intakeUploadVerificationEnabled: false,
    })
  })

  it('allows the observer to accompany the provider-dark venue media runtime', () => {
    expect(
      resolveWorkerStartupPolicy({
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
        VENUE_MEDIA_DERIVATIVE_WORKERS_ENABLED: 'true',
        FOUNDER_ABSENCE_OBSERVER_ENABLED: 'true',
      }),
    ).toMatchObject({ mode: 'venue-media-derivative-only' })
  })

  it.each([
    'CRM_BACKGROUND_WORKERS_ENABLED',
    'INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED',
    'EVALUATION_RUNNER_ENABLED',
    'OUTBOUND_PROVIDER_WORKERS_ENABLED',
  ] as const)('rejects an observer flag that its selected %s runtime would ignore', (flag) => {
    expect(() =>
      resolveWorkerStartupPolicy({
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED:
          flag === 'OUTBOUND_PROVIDER_WORKERS_ENABLED' ? 'true' : 'false',
        FOUNDER_ABSENCE_OBSERVER_ENABLED: 'true',
        [flag]: 'true',
      }),
    ).toThrow('FOUNDER_ABSENCE_OBSERVER_ENABLED can run only by itself or with')
  })

  it('rejects mixing the isolated evaluation runtime with other provider-disabled modes', () => {
    expect(() =>
      resolveWorkerStartupPolicy({
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
        CRM_BACKGROUND_WORKERS_ENABLED: 'true',
        EVALUATION_RUNNER_ENABLED: 'true',
      }),
    ).toThrow('Provider-disabled isolated worker modes cannot be combined')
  })

  it.each(
    WORKER_EXECUTION_FLAGS.filter(
      (flag) =>
        flag !== 'OUTBOUND_PROVIDER_WORKERS_ENABLED' &&
        flag !== 'CRM_BACKGROUND_WORKERS_ENABLED' &&
        flag !== 'INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED' &&
        flag !== 'EVALUATION_RUNNER_ENABLED' &&
        flag !== 'VENUE_MEDIA_DERIVATIVE_WORKERS_ENABLED' &&
        flag !== 'FOUNDER_ABSENCE_OBSERVER_ENABLED',
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
