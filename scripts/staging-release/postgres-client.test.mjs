import assert from 'node:assert/strict'
import test from 'node:test'
import { postgresClient, validateEmptyRestoreTarget } from './postgres-client.mjs'

test('restore preflight accepts only a fresh named disposable database', () => {
  const empty = { database: 'pathfinder_disposable_restore', oid: 16384, userObjectCount: 0, userFunctionCount: 0, userTypeCount: 0, userOperatorCount: 0, extraSchemaCount: 0 }
  assert.equal(validateEmptyRestoreTarget(empty), empty)
  assert.equal(validateEmptyRestoreTarget({ ...empty, oid: '16384' }).oid, '16384')
  for (const change of [
    { ...empty, database: 'production' },
    { ...empty, userObjectCount: 1 },
    { ...empty, userFunctionCount: 1 },
    { ...empty, userTypeCount: 1 },
    { ...empty, userOperatorCount: 1 },
    { ...empty, extraSchemaCount: 1 },
    { ...empty, oid: '0' },
    { ...empty, oid: '4294967296' },
  ]) assert.throws(() => validateEmptyRestoreTarget(change), /restore-target-not-empty/u)
})

test('database client rejects unrelated databases and ports before Docker starts', async () => {
  for (const url of [
    'postgresql://user:pass@127.0.0.1:55432/unrelated_disposable_name',
    'postgresql://user:pass@127.0.0.1:5432/pathfinder_disposable_restore',
    'postgresql://user:pass@127.0.0.1:5433/pathfinder_disposable_source',
  ]) await assert.rejects(postgresClient(url, { name: 'psql', args: [] }), /unsafe-disposable-database-target/u)
})
