import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(
  repositoryRoot,
  'packages/db/prisma/migrations/20260826010000_add_governed_venue_media/migration.sql',
)

test('venue media migration preserves exact scope and requires explicit rights evidence', async () => {
  const sql = await readFile(migrationPath, 'utf8')

  assert.match(sql, /CREATE TABLE "venue_media_assets"/u)
  assert.match(sql, /CREATE TABLE "venue_media_reviews"/u)
  assert.match(
    sql,
    /FOREIGN KEY \("intake_upload_id", "tenant_id", "venue_id"\)[\s\S]*REFERENCES "intake_uploads"\("id", "tenant_id", "venue_id"\)/u,
  )
  assert.match(
    sql,
    /FOREIGN KEY \("place_id", "tenant_id", "venue_id"\)[\s\S]*REFERENCES "places"\("id", "tenant_id", "venue_id"\)/u,
  )
  assert.match(
    sql,
    /FOREIGN KEY \("knowledge_entry_id", "tenant_id", "venue_id"\)[\s\S]*REFERENCES "venue_knowledge_entries"\("id", "tenant_id", "venue_id"\)/u,
  )
  assert.match(sql, /"action" = 'APPROVE_CONTENT_USE'[\s\S]*"rights_basis" IS NOT NULL/u)
  assert.match(sql, /length\(btrim\("rights_statement"\)\) > 0/u)
  assert.match(sql, /length\(btrim\("rights_evidence_source_id"\)\) > 0/u)
  assert.match(sql, /"action" = 'WITHDRAW_CONTENT_USE'[\s\S]*length\(btrim\("reason"\)\) > 0/u)
  assert.doesNotMatch(sql, /visitor_url|public_url|delivery_url/u)
})
