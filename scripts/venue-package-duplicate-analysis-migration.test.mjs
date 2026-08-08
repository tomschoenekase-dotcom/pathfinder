import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(
  repositoryRoot,
  'packages/db/prisma/migrations/20260809070000_add_venue_package_duplicate_analyses/migration.sql',
)

async function migrationSql() {
  return readFile(migrationPath, 'utf8')
}

test('semantic duplicate analysis migration is atomic and legacy packages fail closed', async () => {
  const sql = await migrationSql()
  assert.match(sql, /^BEGIN;$/mu)
  assert.match(sql, /^COMMIT;$/mu)
  assert.ok(sql.indexOf('BEGIN;') < sql.indexOf('COMMIT;'))
  assert.match(sql, /LOCK TABLE "venue_packages" IN ACCESS EXCLUSIVE MODE/u)
  assert.match(sql, /DROP TRIGGER venue_packages_revision_guard ON "venue_packages"/u)
  assert.match(sql, /UPDATE "venue_packages"[\s\S]*"validation_report" = jsonb_set/u)
  assert.match(sql, /"preview_plan" = jsonb_set/u)
  assert.equal((sql.match(/"status": "INCOMPLETE"/gu) ?? []).length, 2)
  assert.equal((sql.match(/"embeddingProfile": "legacy-unavailable"/gu) ?? []).length, 4)
  assert.equal((sql.match(/"code": "SEMANTIC_SCAN_INCOMPLETE"/gu) ?? []).length, 2)
  assert.ok(
    sql.indexOf('UPDATE "venue_packages"') <
      sql.indexOf('CREATE TRIGGER venue_packages_revision_guard'),
  )
})

test('semantic duplicate analysis lifecycle rows are constrained and tenant-bound', async () => {
  const sql = await migrationSql()
  assert.match(
    sql,
    /VenuePackageDuplicateAnalysisStatus" AS ENUM[\s\S]*'RUNNING'[\s\S]*'COMPLETE'[\s\S]*'FAILED'[\s\S]*'STALE'/u,
  )
  assert.match(sql, /venue_package_duplicate_analyses_threshold_check[\s\S]*>= -1[\s\S]*<= 1/u)
  assert.match(sql, /venue_package_duplicate_analyses_lifecycle_check/u)
  assert.match(
    sql,
    /"status" = 'RUNNING'[\s\S]*"result" IS NULL[\s\S]*"draft_id" IS NULL[\s\S]*"error_code" IS NULL[\s\S]*"completed_at" IS NULL/u,
  )
  assert.match(
    sql,
    /"status" = 'COMPLETE'[\s\S]*"result" IS NOT NULL[\s\S]*"draft_id" IS NOT NULL[\s\S]*"error_code" IS NULL[\s\S]*"completed_at" IS NOT NULL/u,
  )
  assert.match(
    sql,
    /"status" IN \('FAILED', 'STALE'\)[\s\S]*"result" IS NULL[\s\S]*"draft_id" IS NULL[\s\S]*"error_code" IS NOT NULL[\s\S]*"completed_at" IS NOT NULL/u,
  )
  assert.match(
    sql,
    /FOREIGN KEY \("venue_id", "tenant_id"\) REFERENCES "venues"\("id", "tenant_id"\)[\s\S]*ON DELETE RESTRICT ON UPDATE RESTRICT/u,
  )
  assert.match(
    sql,
    /FOREIGN KEY \("draft_id", "tenant_id", "venue_id"\)[\s\S]*REFERENCES "venue_packages"\("id", "tenant_id", "venue_id"\)[\s\S]*ON DELETE RESTRICT ON UPDATE RESTRICT/u,
  )
  assert.match(sql, /venue_packages_id_tenant_id_venue_id_key/u)
  assert.match(sql, /venue_package_duplicate_analyses_tenant_id_venue_id_draft_key_key/u)
  assert.match(sql, /venue_package_duplicate_analyses_draft_id_key/u)
})

test('semantic duplicate analyses guard identity, terminal transitions, deletion, and truncate', async () => {
  const sql = await migrationSql()
  assert.match(sql, /CREATE FUNCTION pathfinder_guard_venue_package_duplicate_analysis\(\)/u)
  assert.match(
    sql,
    /TG_OP = 'DELETE'[\s\S]*venue package duplicate analyses are immutable evidence/u,
  )
  for (const immutableColumn of [
    'tenant_id',
    'venue_id',
    'draft_key',
    'payload_hash',
    'base_digest',
    'claim_token',
    'embedding_profiles',
    'similarity_threshold',
    'created_by',
    'created_at',
  ]) {
    assert.match(
      sql,
      new RegExp(`NEW\\."${immutableColumn}" IS DISTINCT FROM OLD\\."${immutableColumn}"`, 'u'),
    )
  }
  assert.match(sql, /OLD\."status" <> 'RUNNING'/u)
  assert.match(sql, /NEW\."status" NOT IN \('COMPLETE', 'FAILED', 'STALE'\)/u)
  assert.match(
    sql,
    /CREATE TRIGGER venue_package_duplicate_analyses_revision_guard[\s\S]*BEFORE UPDATE OR DELETE/u,
  )
  assert.match(
    sql,
    /CREATE FUNCTION pathfinder_guard_venue_package_duplicate_analysis_truncate\(\)[\s\S]*venue package duplicate analyses are immutable evidence/u,
  )
  assert.match(
    sql,
    /CREATE TRIGGER venue_package_duplicate_analyses_truncate_guard[\s\S]*BEFORE TRUNCATE/u,
  )
})
