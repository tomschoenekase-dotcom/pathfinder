import { describe, expect, it } from 'vitest'

import {
  DatabaseTestEnvironmentRefusal,
  resolveDatabaseTestEnvironment,
} from './test-environment-boundary'

const disposableUrl =
  'postgresql://pathfinder:synthetic@127.0.0.1:55439/pathfinder_disposable_boundary'

describe('database test environment boundary', () => {
  it('replaces inherited database targets when no integration gate is enabled', () => {
    const target = resolveDatabaseTestEnvironment({
      DATABASE_URL: 'postgresql://inherited:fake@external.invalid:5432/wrong',
      DIRECT_DATABASE_URL: 'postgresql://inherited:fake@external.invalid:5432/wrong',
    })
    expect(target.integration).toBe(false)
    expect(target.databaseUrl).toBe(
      'postgresql://pathfinder_test:pathfinder_test@127.0.0.1:5432/pathfinder_test',
    )
    expect(target.directDatabaseUrl).toBe(target.databaseUrl)
  })

  it('accepts only identical explicit disposable loopback targets in integration mode', () => {
    expect(
      resolveDatabaseTestEnvironment({
        RUN_EXAMPLE_DB_INTEGRATION: '1',
        DATABASE_URL: disposableUrl,
        DIRECT_DATABASE_URL: disposableUrl,
      }),
    ).toEqual({ databaseUrl: disposableUrl, directDatabaseUrl: disposableUrl, integration: true })
  })

  it.each([
    {},
    {
      RUN_EXAMPLE_DB_INTEGRATION: '1',
      DATABASE_URL: 'postgresql://synthetic@external.invalid:5432/pathfinder_disposable_boundary',
      DIRECT_DATABASE_URL:
        'postgresql://synthetic@external.invalid:5432/pathfinder_disposable_boundary',
    },
    {
      RUN_EXAMPLE_DB_INTEGRATION: '1',
      DATABASE_URL: disposableUrl,
      DIRECT_DATABASE_URL:
        'postgresql://pathfinder:synthetic@127.0.0.1:55439/pathfinder_disposable_other',
    },
    {
      RUN_EXAMPLE_DB_INTEGRATION: '1',
      DATABASE_URL: `${disposableUrl}?schema=public`,
      DIRECT_DATABASE_URL: `${disposableUrl}?schema=public`,
    },
  ])(
    'refuses incomplete, external, mismatched, or option-bearing integration targets: %#',
    (environment) => {
      expect(() =>
        resolveDatabaseTestEnvironment({ RUN_EXAMPLE_DB_INTEGRATION: '1', ...environment }),
      ).toThrow(DatabaseTestEnvironmentRefusal)
    },
  )
})
