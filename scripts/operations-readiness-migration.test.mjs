import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsPath = path.join(repositoryRoot, 'packages', 'db', 'prisma', 'migrations')
const operationalHealthPath = path.join(
  repositoryRoot,
  'packages',
  'db',
  'src',
  'helpers',
  'operational-health.ts',
)

test('operations readiness expects the exact latest reviewed migration', async () => {
  const migrations = (await readdir(migrationsPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
  assert.ok(migrations.length > 0)

  const source = await readFile(operationalHealthPath, 'utf8')
  const match = source.match(/export const EXPECTED_LATEST_MIGRATION = '([0-9]{14}_[a-z0-9_]+)'/u)
  assert.ok(match, 'operational readiness exports one literal reviewed migration identity')
  assert.equal(match[1], migrations.at(-1))
})
