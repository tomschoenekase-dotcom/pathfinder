import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(
  repositoryRoot,
  'packages/db/prisma/migrations/20260809050000_add_venue_packages/migration.sql',
)

test('venue package migration is atomic and keys draft/command idempotency explicitly', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  assert.match(sql, /^BEGIN;$/mu)
  assert.match(sql, /^COMMIT;$/mu)
  assert.match(sql, /VenuePackageStatus" AS ENUM \('DRAFT', 'APPROVED', 'APPLIED', 'REVERTED'\)/u)
  assert.match(sql, /venue_packages_tenant_id_venue_id_draft_key_key/u)
  assert.match(sql, /venue_packages_tenant_id_approved_command_key_key/u)
  assert.match(sql, /venue_packages_tenant_id_applied_command_key_key/u)
  assert.match(sql, /venue_packages_tenant_id_reverted_command_key_key/u)
  assert.doesNotMatch(sql, /one_applied_per_venue/u)
  assert.match(sql, /CONSTRAINT "venue_packages_lifecycle_check" CHECK/u)
})

test('venue package revisions and lifecycle attribution are database guarded', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  assert.match(sql, /CREATE FUNCTION pathfinder_guard_venue_package_revision\(\)/u)
  assert.match(sql, /TG_OP = 'DELETE'[\s\S]*venue package revisions are immutable/u)
  for (const immutableColumn of [
    'tenant_id',
    'venue_id',
    'draft_key',
    'schema_version',
    'payload',
    'payload_hash',
    'base_digest',
    'validation_report',
    'preview_plan',
    'created_by',
    'created_at',
  ]) {
    assert.match(
      sql,
      new RegExp(`NEW\\."${immutableColumn}" IS DISTINCT FROM OLD\\."${immutableColumn}"`, 'u'),
    )
  }
  assert.match(sql, /OLD\."status" = 'DRAFT' AND NEW\."status" = 'APPROVED'/u)
  assert.match(sql, /OLD\."status" = 'APPROVED' AND NEW\."status" = 'APPLIED'/u)
  assert.match(sql, /OLD\."status" = 'APPLIED' AND NEW\."status" = 'REVERTED'/u)
  assert.match(sql, /venue package approval attribution is immutable/u)
  assert.match(sql, /venue package application evidence is immutable/u)
  assert.match(sql, /CREATE TRIGGER venue_packages_truncate_guard/u)
})
