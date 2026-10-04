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

test('operations readiness pins the reviewed 267 migration endpoint', async () => {
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
  assert.equal(match[1], '20261002121000_prospect_organization_merge')
  assert.equal(migrations.length, 267)
  assert.equal(migrations.at(-1), match[1])
  assert.deepEqual(migrations.slice(255), [
    '20261002090000_add_live_data_connectors',
    '20261002091000_add_client_notification_intents',
    '20261002092000_add_venue_sources',
    '20261002100000_add_venue_recommendations',
    '20261002110000_add_operator_decisions_and_job_grants',
    '20261002111000_add_client_inbound_replies',
    '20261002112000_add_routine_stop_rules_and_budgets',
    '20261002113000_add_offboarding_execution',
    '20261002114000_fix_external_credential_capability_collation',
    '20261002115000_allow_client_reported_voice_usage',
    '20261002120000_add_prospect_provider_draft_reference',
    '20261002121000_prospect_organization_merge',
  ])
  assert.equal(migrations[251], '20260927090000_add_venue_chat_appearance')
  assert.equal(migrations[249], '20260918190000_add_agent_routines')
  assert.deepEqual(migrations.slice(250, 255), [
    '20260926120000_add_venue_distribution',
    '20260927090000_add_venue_chat_appearance',
    '20260930100000_add_mcp_venue_appearance_capabilities',
    '20261001090000_add_operator_oauth',
    '20261001100000_crm_receipt_and_execution_foundations',
  ])
})
