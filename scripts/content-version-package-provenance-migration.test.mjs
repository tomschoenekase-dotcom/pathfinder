import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(
  repositoryRoot,
  'packages/db/prisma/migrations/20260809080000_add_content_version_package_provenance/migration.sql',
)

test('package provenance migration is atomic, nullable for legacy rows, and exactly scoped', async () => {
  const sql = await readFile(migrationPath, 'utf8')

  assert.match(sql, /^BEGIN;$/mu)
  assert.match(sql, /^COMMIT;$/mu)
  assert.equal(sql.match(/^BEGIN;$/gmu)?.length, 1)
  assert.equal(sql.match(/^COMMIT;$/gmu)?.length, 1)
  assert.match(sql, /ADD COLUMN "venue_package_id" TEXT,/u)
  assert.match(sql, /ADD COLUMN "venue_package_item_key" UUID,/u)
  assert.match(sql, /ADD COLUMN "venue_package_action" TEXT,/u)
  assert.match(sql, /ADD COLUMN "source_provenance" JSONB;/u)
  assert.doesNotMatch(sql, /UPDATE "content_versions"/u)
  assert.match(sql, /ALTER TABLE "places"[\s\S]*"source_type" TEXT NOT NULL DEFAULT 'UNKNOWN'/u)
  assert.match(
    sql,
    /ALTER TABLE "venue_knowledge_entries"[\s\S]*"authorship" TEXT NOT NULL DEFAULT 'UNKNOWN'/u,
  )
  assert.match(sql, /places_source_package_scope_fkey/u)
  assert.match(sql, /venue_knowledge_entries_source_package_scope_fkey/u)
  assert.match(
    sql,
    /FOREIGN KEY \("venue_package_id", "tenant_id", "venue_id"\)[\s\S]*REFERENCES "venue_packages"\("id", "tenant_id", "venue_id"\)[\s\S]*ON DELETE RESTRICT ON UPDATE RESTRICT/u,
  )
})

test('package provenance is structurally guarded, immutable, and permits one apply and revert', async () => {
  const sql = await readFile(migrationPath, 'utf8')

  assert.match(sql, /content_versions_package_provenance_all_or_none_check/u)
  assert.match(sql, /"venue_package_action" IN \('APPLY', 'REVERT'\)/u)
  assert.match(sql, /content_versions_source_provenance_shape_check/u)
  assert.match(sql, /places_provenance_shape_check/u)
  assert.match(sql, /venue_knowledge_entries_provenance_shape_check/u)
  assert.match(sql, /'HUMAN_AUTHORED', 'AI_GENERATED'/u)
  assert.match(sql, /content_versions_package_action_item_key_key/u)
  assert.match(sql, /"venue_package_id", "venue_package_action", "venue_package_item_key"/u)
  assert.match(sql, /content_versions_package_action_entity_key/u)
  assert.match(sql, /BEFORE INSERT ON "content_versions"/u)
  assert.match(sql, /current_setting\('pathfinder\.venue_package_id', true\)/u)
  assert.match(sql, /current_setting\('pathfinder\.source_provenance', true\)/u)
  assert.match(sql, /captured_action = 'APPLY'[\s\S]*captured_package_status <> 'APPROVED'/u)
  assert.match(sql, /captured_action = 'REVERT'[\s\S]*captured_package_status <> 'APPLIED'/u)
  assert.match(sql, /package revert ancestry does not match its apply version/u)
  assert.match(sql, /captured_entity_type IN \('PLACE', 'KNOWLEDGE_ENTRY'\) THEN 2 ELSE 1 END/u)
  assert.match(sql, /'sourcePackageId', OLD\.source_package_id/u)
  assert.match(sql, /'sourcePackageId', NEW\.source_package_id/u)
  assert.match(sql, /NEW\.entity_type NOT IN \('VENUE', 'PLACE', 'KNOWLEDGE_ENTRY'\)/u)
  assert.match(sql, /to_char\(NEW\.imported_at, 'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)/u)
  assert.match(sql, /content version package provenance cannot target this entity type/u)
})
