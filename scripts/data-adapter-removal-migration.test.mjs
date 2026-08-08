import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(
  repositoryRoot,
  'packages/db/prisma/migrations/20260809090000_remove_data_adapters/migration.sql',
)
const schemaPath = path.join(repositoryRoot, 'packages/db/prisma/schema.prisma')
const registryPath = path.join(repositoryRoot, 'packages/db/src/tenanted-tables.ts')
const databaseIndexPath = path.join(repositoryRoot, 'packages/db/src/index.ts')

test('data adapter removal is atomic and refuses to discard populated scaffolding', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  const timeoutIndex = sql.indexOf("SET LOCAL lock_timeout = '5s'")
  const lockIndex = sql.indexOf('LOCK TABLE "data_adapters" IN ACCESS EXCLUSIVE MODE')
  const guardIndex = sql.indexOf('IF EXISTS (SELECT 1 FROM "data_adapters" LIMIT 1)')
  const dropIndex = sql.indexOf('DROP TABLE "data_adapters"')

  assert.match(sql, /^BEGIN;$/mu)
  assert.match(sql, /^COMMIT;$/mu)
  assert.equal(sql.match(/^BEGIN;$/gmu)?.length, 1)
  assert.equal(sql.match(/^COMMIT;$/gmu)?.length, 1)
  assert.ok(timeoutIndex >= 0, 'the migration must bound its exclusive-lock wait')
  assert.ok(timeoutIndex < lockIndex, 'the lock timeout must be set before taking the lock')
  assert.ok(lockIndex >= 0, 'the placeholder table must be exclusively locked')
  assert.ok(lockIndex < guardIndex, 'the exclusive lock must precede the emptiness proof')
  assert.ok(guardIndex < dropIndex, 'the emptiness proof must precede the drop')
  assert.match(sql, /RAISE EXCEPTION[\s\S]*export and reconcile/u)
  assert.equal(sql.match(/DROP TABLE "data_adapters"/gu)?.length, 1)
  assert.doesNotMatch(sql, /CASCADE/u)
})

test('current schema and isolation exports no longer advertise DataAdapter', async () => {
  const [schema, registry, databaseIndex] = await Promise.all([
    readFile(schemaPath, 'utf8'),
    readFile(registryPath, 'utf8'),
    readFile(databaseIndexPath, 'utf8'),
  ])

  assert.doesNotMatch(schema, /model DataAdapter\b/u)
  assert.doesNotMatch(schema, /\badapters\s+DataAdapter\[\]/u)
  assert.doesNotMatch(registry, /['"]DataAdapter['"]/u)
  assert.doesNotMatch(databaseIndex, /\bDataAdapter\b/u)
})
