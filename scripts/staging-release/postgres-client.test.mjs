import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { postgresClient, postgresClientStream, validateEmptyRestoreTarget } from './postgres-client.mjs'

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

test('postgres client streams synthetic dumps beyond 64 MiB without buffering', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
  const result = postgresClientStream('postgresql://user:pass@127.0.0.1:55432/pathfinder_disposable_source', { name: 'pg_dump', args: [] }, {
    spawnImpl: (_file, _args, options) => {
      assert.equal(options.shell, false)
      setImmediate(() => {
        const chunk = Buffer.alloc(1024 * 1024, 0x7a)
        for (let index = 0; index < 65; index++) child.stdout.write(chunk)
        child.stdout.end()
        child.emit('close', 0)
      })
      return child
    },
  })
  let bytes = 0
  for await (const chunk of result.stream) bytes += chunk.length
  await result.completion
  assert.equal(bytes, 65 * 1024 * 1024)
})

test('database client rejects unrelated databases and ports before Docker starts', async () => {
  for (const url of [
    'postgresql://user:pass@127.0.0.1:55432/unrelated_disposable_name',
    'postgresql://user:pass@127.0.0.1:5432/pathfinder_disposable_restore',
    'postgresql://user:pass@127.0.0.1:5433/pathfinder_disposable_source',
  ]) await assert.rejects(postgresClient(url, { name: 'psql', args: [] }), /unsafe-disposable-database-target/u)
})
