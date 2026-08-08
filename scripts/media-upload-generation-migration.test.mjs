import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(
  repositoryRoot,
  'packages/db/prisma/migrations/20260808233000_add_media_upload_generation_identity/migration.sql',
)

test('generation migration atomically blocks legacy active media states', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  const lockIndex = sql.indexOf('LOCK TABLE "media_ingestion_projects" IN ACCESS EXCLUSIVE MODE')
  const preflightIndex = sql.indexOf('IF EXISTS')
  const alterIndex = sql.indexOf('ALTER TABLE "media_ingestion_projects"')
  const blockEndIndex = sql.lastIndexOf('$$;')

  assert.ok(lockIndex >= 0, 'migration must lock media projects before its drain preflight')
  assert.ok(lockIndex < preflightIndex, 'migration lock must precede the drain preflight')
  assert.ok(preflightIndex < alterIndex, 'drain preflight must precede schema mutation')
  assert.ok(alterIndex < blockEndIndex, 'schema mutation must remain in the atomic DO block')
  assert.match(
    sql,
    /WHERE "status" IN \('UPLOADING', 'INVENTORYING', 'ANALYZING', 'SYNTHESIZING'\)/u,
  )
  assert.match(sql, /Media upload ingress and workers must be stopped/u)
})
