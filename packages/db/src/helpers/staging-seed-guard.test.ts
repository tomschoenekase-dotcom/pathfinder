import { describe, expect, it } from 'vitest'

import { assertStagingSeedTarget, type StagingSeedEnvironment } from './staging-seed-guard'

const target: StagingSeedEnvironment = {
  RAILWAY_ENVIRONMENT: 'staging',
  DATABASE_URL: 'postgresql://user:secret@pool.staging.example:6543/pathfinder_staging',
  DIRECT_DATABASE_URL: 'postgresql://user:secret@direct.staging.example:5432/pathfinder_staging',
  PATHFINDER_ALLOW_STAGING_SEED: '1',
  PATHFINDER_CONFIRM_STAGING_DATABASE_HOST: 'pool.staging.example',
  PATHFINDER_CONFIRM_STAGING_DIRECT_DATABASE_HOST: 'direct.staging.example',
  PATHFINDER_CONFIRM_STAGING_DATABASE_NAME: 'pathfinder_staging',
}

describe('staging seed target guard', () => {
  it('requires an exact staging opt-in and both URL identities', () => {
    expect(assertStagingSeedTarget(target)).toEqual({
      databaseHost: 'pool.staging.example',
      directDatabaseHost: 'direct.staging.example',
      database: 'pathfinder_staging',
    })
  })

  it.each([
    ['production label', { RAILWAY_ENVIRONMENT: 'production' }],
    ['missing opt-in', { PATHFINDER_ALLOW_STAGING_SEED: undefined }],
    ['pooled host mismatch', { PATHFINDER_CONFIRM_STAGING_DATABASE_HOST: 'other.example' }],
    ['direct host mismatch', { PATHFINDER_CONFIRM_STAGING_DIRECT_DATABASE_HOST: 'other.example' }],
    ['database mismatch', { PATHFINDER_CONFIRM_STAGING_DATABASE_NAME: 'postgres' }],
    [
      'URL database mismatch',
      { DIRECT_DATABASE_URL: 'postgresql://user:secret@direct.staging.example/other' },
    ],
  ])('rejects %s before mutation', (_label, override) => {
    expect(() => assertStagingSeedTarget({ ...target, ...override })).toThrow()
  })

  it('never includes URL credentials in errors', () => {
    try {
      assertStagingSeedTarget({ ...target, PATHFINDER_CONFIRM_STAGING_DATABASE_HOST: 'wrong' })
    } catch (error) {
      expect(String(error)).not.toContain('secret')
      expect(String(error)).not.toContain('user')
    }
  })
})
