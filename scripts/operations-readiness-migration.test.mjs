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

test('operations readiness pins the reviewed 255 migration endpoint', async () => {
  const migrations = (await readdir(migrationsPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
  assert.ok(migrations.length > 0)

  const source = await readFile(operationalHealthPath, 'utf8')
  const match = source.match(
    /export const EXPECTED_LATEST_MIGRATION\s*=\s*'([0-9]{14}_[a-z0-9_]+)'/u,
  )
  assert.ok(match, 'operational readiness exports one literal reviewed migration identity')
  assert.equal(match[1], '20261001100000_crm_receipt_and_execution_foundations')
  assert.equal(migrations.length, 255)
  assert.equal(migrations.at(-1), match[1])
  assert.equal(migrations.at(-4), '20260927090000_add_venue_chat_appearance')
  assert.equal(migrations.at(-6), '20260918190000_add_agent_routines')
  assert.deepEqual(migrations.slice(-5), [
    '20260926120000_add_venue_distribution',
    '20260927090000_add_venue_chat_appearance',
    '20260930100000_add_mcp_venue_appearance_capabilities',
    '20261001090000_add_operator_oauth',
    '20261001100000_crm_receipt_and_execution_foundations',
  ])
})
