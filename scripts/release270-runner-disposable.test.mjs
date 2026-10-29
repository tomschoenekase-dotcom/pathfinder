import assert from 'node:assert/strict'
import test from 'node:test'
import {
  guardRelease270Disposable,
  SOURCE_DATABASE,
  RESTORE_DATABASE,
} from './release270-runner-disposable.mjs'

const fixture = () => ({
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  RELEASE270_RUNNER_CONFIRM: SOURCE_DATABASE,
  PATHFINDER_DISPOSABLE_DATABASE_URL: `postgresql://postgres:fictional@127.0.0.1:5432/${SOURCE_DATABASE}`,
  RELEASE270_RESTORE_DATABASE_URL: `postgresql://postgres:fictional@127.0.0.1:5432/${RESTORE_DATABASE}`,
  RELEASE270_DISPOSABLE_REDIS_URL: 'redis://127.0.0.1:6379',
})
test('disposable guard admits only two explicit loopback databases and Redis', () => {
  const target = guardRelease270Disposable(fixture())
  assert.notEqual(target.source, target.restore)
  assert.equal(new URL(target.source).hostname, '127.0.0.1')
})
test('disposable guard rejects hosted targets, confirmation errors and inherited overrides', () => {
  for (const [key, value] of [
    ['RUNNER_ENVIRONMENT', 'self-hosted'],
    ['RELEASE270_RUNNER_CONFIRM', 'other'],
    [
      'PATHFINDER_DISPOSABLE_DATABASE_URL',
      `postgresql://fictional@database.railway.internal:5432/${SOURCE_DATABASE}`,
    ],
    ['RELEASE270_RESTORE_DATABASE_URL', `postgresql://fictional@127.0.0.1:5432/${SOURCE_DATABASE}`],
    ['RELEASE270_DISPOSABLE_REDIS_URL', 'redis://example.com:6379'],
    ['RELEASE270_DISPOSABLE_REDIS_URL', 'redis://127.0.0.1:6379/1'],
    ['NODE_OPTIONS', '--inspect'],
    ['PGSERVICE', 'fictional'],
    ['PRISMA_QUERY_ENGINE_LIBRARY', '/fictional'],
  ])
    assert.throws(() => guardRelease270Disposable({ ...fixture(), [key]: value }))
})
