import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const backupScript = await readFile(
  path.join(scriptsDirectory, 'prepare-supabase-logical-backup.ps1'),
  'utf8',
)

test('Supabase backup is fixed to the approved project and free IPv4 session pooler', () => {
  assert.match(backupScript, /\$projectRef = 'zpacmfkomonxeqdiadtz'/u)
  assert.match(backupScript, /aws-1-us-east-2\.pooler\.supabase\.com/u)
  assert.match(backupScript, /\$databaseUser = "postgres\.\$projectRef"/u)
  assert.match(backupScript, /--env PGSSLMODE=require/u)
})

test('Supabase backup takes a bounded consistent logical snapshot without credential arguments', () => {
  assert.match(backupScript, /pg_dump/u)
  assert.match(backupScript, /--format=custom/u)
  assert.match(backupScript, /--serializable-deferrable/u)
  assert.match(backupScript, /--lock-wait-timeout=10s/u)
  assert.doesNotMatch(backupScript, /PGPASSWORD|--password=|\[YOUR-PASSWORD\]/u)
})

test('Supabase backup refuses overwrite and verifies archive readability and hash', () => {
  assert.match(backupScript, /Refusing to overwrite existing backup/u)
  assert.match(backupScript, /pg_restore --list/u)
  assert.match(backupScript, /Get-FileHash[^\n]+SHA256/u)
  assert.match(backupScript, /archive_listing_verified = \$true/u)
  assert.match(backupScript, /production_mutations_performed = \$false/u)
})
