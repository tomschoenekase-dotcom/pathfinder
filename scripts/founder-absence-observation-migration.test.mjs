import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath =
  'packages/db/prisma/migrations/20260828174000_add_founder_absence_observations/migration.sql'

test('founder absence observations are one immutable platform sample per UTC date', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  const schema = await readFile('packages/db/prisma/schema.prisma', 'utf8')
  const tablePolicy = await readFile('packages/db/src/tenanted-tables.ts', 'utf8')
  const tenantedTablePolicy = tablePolicy.slice(
    tablePolicy.indexOf('export const TENANTED_TABLES'),
    tablePolicy.indexOf('export const PLATFORM_TABLES'),
  )

  assert.match(sql, /CREATE TABLE "founder_absence_observations"/u)
  assert.match(sql, /"observed_on" DATE NOT NULL/u)
  assert.match(sql, /CREATE UNIQUE INDEX "founder_absence_observations_observed_on_key"/u)
  assert.match(sql, /BEFORE UPDATE OR DELETE/u)
  assert.match(sql, /BEFORE TRUNCATE/u)
  assert.match(sql, /CHECK \("release_sha" ~ '\^\[0-9a-f\]\{40\}\$'\)/u)
  assert.match(sql, /CHECK \("snapshot_hash" ~ '\^\[0-9a-f\]\{64\}\$'\)/u)
  assert.match(schema, /model FounderAbsenceObservation \{/u)
  assert.match(tablePolicy, /export const PLATFORM_TABLES = \[[\s\S]*'FounderAbsenceObservation'/u)
  assert.doesNotMatch(tenantedTablePolicy, /'FounderAbsenceObservation'/u)
})
