import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(
  repositoryRoot,
  'packages/db/prisma/migrations/20260809060000_add_venue_report_configurations/migration.sql',
)

test('venue report configuration migration is atomic and fail-closed for existing venues', async () => {
  const sql = await readFile(migrationPath, 'utf8')

  assert.match(sql, /^BEGIN;$/mu)
  assert.match(sql, /^COMMIT;$/mu)
  assert.match(sql, /"enabled" BOOLEAN NOT NULL DEFAULT false/u)
  assert.doesNotMatch(sql, /INSERT INTO "venue_report_configurations"/u)
  assert.match(sql, /venue_report_configurations_tenant_id_enabled_venue_id_idx/u)
})

test('venue report configuration migration enforces composite ownership and safe venue deletion', async () => {
  const sql = await readFile(migrationPath, 'utf8')

  assert.match(sql, /CREATE UNIQUE INDEX "venues_id_tenant_id_key"/u)
  assert.match(sql, /venue_report_configurations_venue_id_key/u)
  assert.match(
    sql,
    /FOREIGN KEY \("venue_id", "tenant_id"\) REFERENCES "venues"\("id", "tenant_id"\)\s+ON DELETE CASCADE ON UPDATE RESTRICT/su,
  )
  assert.match(
    sql,
    /FOREIGN KEY \("tenant_id"\) REFERENCES "tenants"\("id"\)\s+ON DELETE RESTRICT ON UPDATE RESTRICT/su,
  )
})
