import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(
  repositoryRoot,
  'packages/db/prisma/migrations/20260809040000_complete_operational_updates/migration.sql',
)

test('operational update migration preserves existing visibility and closes the history gap', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  const sourceLock = sql.indexOf('LOCK TABLE "operational_updates" IN SHARE ROW EXCLUSIVE MODE')
  const historyLock = sql.indexOf('LOCK TABLE "content_versions" IN ACCESS EXCLUSIVE MODE')
  const backfill = sql.indexOf('UPDATE "operational_updates"')
  const baseline = sql.indexOf('\'OPERATIONAL_UPDATE\',\n  ou."id",')
  const trigger = sql.indexOf('CREATE TRIGGER operational_updates_content_version')

  assert.match(sql, /^BEGIN;$/mu)
  assert.match(sql, /^COMMIT;$/mu)
  assert.ok(sourceLock >= 0 && historyLock > sourceLock)
  assert.ok(backfill > historyLock)
  assert.match(sql, /"status" = 'PUBLISHED'/u)
  assert.match(sql, /"published_by" = "created_by"/u)
  assert.match(sql, /"published_at" = "created_at"/u)
  assert.ok(baseline > backfill, 'populated updates require restorable baseline versions')
  assert.ok(trigger > baseline, 'capture trigger must follow the baseline')
})

test('operational update migration blocks legacy states that would be truncated', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  const sourceLock = sql.indexOf('LOCK TABLE "operational_updates" IN SHARE ROW EXCLUSIVE MODE')
  const capacityGuard = sql.indexOf('HAVING count(*) > 20')
  const schemaMutation = sql.indexOf('CREATE TYPE "OperationalUpdatePriority"')

  assert.ok(capacityGuard > sourceLock, 'capacity must be checked while legacy writers are drained')
  assert.ok(schemaMutation > capacityGuard, 'capacity must block before the first schema mutation')
  assert.match(sql, /WHERE "is_active" = true\s+AND "expires_at" > CURRENT_TIMESTAMP/su)
  assert.match(sql, /GROUP BY "tenant_id", "venue_id"\s+HAVING count\(\*\) > 20/su)
  assert.match(sql, /RAISE EXCEPTION\s+'operational update migration blocked:/su)
})

test('operational update migration enforces lifecycle, schedule, and immutable history fields', async () => {
  const sql = await readFile(migrationPath, 'utf8')

  assert.match(sql, /OperationalUpdateStatus" AS ENUM \('DRAFT', 'PUBLISHED'\)/u)
  assert.match(sql, /OperationalUpdatePriority" AS ENUM \('LOW', 'NORMAL', 'HIGH', 'URGENT'\)/u)
  for (const type of [
    'TEMPORARY_CLOSURE',
    'UNAVAILABLE_EXHIBIT',
    'CHANGED_HOURS',
    'MAINTENANCE',
    'SPECIAL_EVENT',
    'SOLD_OUT_ACTIVITY',
    'TEMPORARY_VENDOR_LOCATION',
  ]) {
    assert.match(sql, new RegExp(`'${type}'`, 'u'))
  }
  assert.match(sql, /CHECK \("starts_at" < "expires_at"\)/u)
  assert.match(sql, /"status" = 'DRAFT'.*"is_active" = false/su)
  assert.match(sql, /"status" = 'PUBLISHED'.*"published_by" IS NOT NULL/su)
  assert.match(sql, /operational_updates_guest_visibility_idx/u)
  assert.match(sql, /'OPERATIONAL_UPDATE'/u)
  assert.match(sql, /current_setting\('pathfinder\.actor_id', true\)/u)
  assert.match(sql, /current_setting\('pathfinder\.reverted_from_id', true\)/u)
  assert.doesNotMatch(sql, /'updatedAt'/u)
})
