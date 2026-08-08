import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(
  repositoryRoot,
  'packages/db/prisma/migrations/20260809120000_add_media_source_fingerprint/migration.sql',
)
const projectHelperPath = path.join(
  repositoryRoot,
  'packages/api/src/routers/admin/media-ingestion-helpers.ts',
)
const dashboardIdentityPath = path.join(
  repositoryRoot,
  'apps/dashboard/lib/media-source-identity.ts',
)
const mediaStoragePath = path.join(repositoryRoot, 'packages/api/src/lib/media-storage.ts')

test('media source fingerprint migration is additive, paired, and format constrained', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  assert.match(sql, /^BEGIN;/u)
  assert.match(sql, /COMMIT;\s*$/u)
  assert.match(sql, /ADD COLUMN "source_fingerprint_algorithm" VARCHAR\(48\)/u)
  assert.match(sql, /ADD COLUMN "source_fingerprint" CHAR\(64\)/u)
  assert.match(sql, /"source_fingerprint_algorithm" IS NULL\s+AND "source_fingerprint" IS NULL/u)
  assert.match(
    sql,
    /"source_fingerprint_algorithm" IS NOT NULL\s+AND "source_fingerprint" IS NOT NULL/u,
  )
  assert.match(sql, /'pathfinder-sha256-part-manifest-v1'/u)
  assert.match(sql, /\^\[0-9a-f\]\{64\}\$/u)
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|DROP|TRUNCATE)\b/iu)
})

test('media project responses expose fingerprint capability but not the digest', async () => {
  const source = await readFile(projectHelperPath, 'utf8')
  const select = source.slice(
    source.indexOf('export const mediaIngestionProjectSelect'),
    source.indexOf('export function serializeMediaIngestionProject'),
  )
  assert.match(select, /sourceFingerprintAlgorithm:\s*true/u)
  assert.doesNotMatch(select, /sourceFingerprint:\s*true/u)
})

test('browser fingerprint protocol stays aligned with API upload boundaries', async () => {
  const [dashboard, helpers, storage] = await Promise.all([
    readFile(dashboardIdentityPath, 'utf8'),
    readFile(projectHelperPath, 'utf8'),
    readFile(mediaStoragePath, 'utf8'),
  ])
  for (const source of [dashboard, helpers]) {
    assert.match(source, /pathfinder-sha256-part-manifest-v1/u)
    assert.match(source, /5 \* 1024 \* 1024 \* 1024/u)
  }
  assert.match(dashboard, /MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES = 16 \* 1024 \* 1024/u)
  assert.match(storage, /MEDIA_UPLOAD_PART_SIZE = 16 \* 1024 \* 1024/u)
})
