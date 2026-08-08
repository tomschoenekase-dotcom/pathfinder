import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(
  repositoryRoot,
  'packages/db/prisma/migrations/20260809030000_add_content_versions/migration.sql',
)

test('content history migration is atomic and closes the baseline capture gap', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  const lockIndex = sql.indexOf(
    'LOCK TABLE "venues", "places", "venue_knowledge_entries" IN SHARE ROW EXCLUSIVE MODE',
  )
  const tableIndex = sql.indexOf('CREATE TABLE "content_versions"')
  const venueBaselineIndex = sql.indexOf("venue.tenant_id, venue.id, 'VENUE'")
  const placeBaselineIndex = sql.indexOf("place.tenant_id, place.venue_id, 'PLACE'")
  const knowledgeBaselineIndex = sql.indexOf("entry.tenant_id, entry.venue_id, 'KNOWLEDGE_ENTRY'")
  const firstCaptureTriggerIndex = sql.indexOf('CREATE TRIGGER venues_content_version')

  assert.match(sql, /^BEGIN;$/mu)
  assert.match(sql, /^COMMIT;$/mu)
  assert.equal(sql.match(/^BEGIN;$/gmu)?.length, 1)
  assert.equal(sql.match(/^COMMIT;$/gmu)?.length, 1)
  assert.ok(lockIndex >= 0, 'all baseline source tables must be write-locked')
  assert.ok(lockIndex < tableIndex, 'write lock must precede history schema mutation')
  for (const baselineIndex of [venueBaselineIndex, placeBaselineIndex, knowledgeBaselineIndex]) {
    assert.ok(baselineIndex > tableIndex, 'each source table must receive a baseline')
    assert.ok(
      baselineIndex < firstCaptureTriggerIndex,
      'each baseline must be complete before capture triggers are installed',
    )
  }
})

test('content history migration preserves immutable, versioned, tenant-scoped recovery', async () => {
  const sql = await readFile(migrationPath, 'utf8')

  assert.match(sql, /"snapshot_schema_version" INTEGER NOT NULL DEFAULT 1/u)
  assert.match(sql, /FOREIGN KEY \("tenant_id"\).*ON DELETE RESTRICT ON UPDATE RESTRICT/su)
  assert.match(sql, /BEFORE UPDATE OR DELETE ON "content_versions"/u)
  assert.match(sql, /BEFORE TRUNCATE ON "content_versions"/u)
  assert.match(sql, /content_versions_tenant_id_entity_type_entity_id_sequence_idx/u)
  assert.match(sql, /content_versions_tenant_id_entity_type_sequence_idx/u)
  assert.match(sql, /content_versions_tenant_id_venue_id_sequence_idx/u)
  assert.match(sql, /current_setting\('pathfinder\.actor_id', true\)/u)
  assert.match(sql, /current_setting\('pathfinder\.reverted_from_id', true\)/u)
})
