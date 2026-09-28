import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { decryptArchive, sha256 } from './archive.mjs'
import { assertEmptyRestoreTarget, postgresClient, syntheticSnapshot } from './postgres-client.mjs'

function inputDir(args) {
  if (args.length !== 2 || args[0] !== '--input-dir' || !args[1]) throw new Error('restore-input-dir-required')
  return path.resolve(args[1])
}

try {
  const directory = inputDir(process.argv.slice(2))
  const source = new URL(process.env.DATABASE_URL || 'postgresql://none:none@127.0.0.1:1/pathfinder_disposable_source')
  const target = new URL(process.env.RESTORE_DATABASE_URL)
  if (source.href === target.href || target.pathname !== '/pathfinder_disposable_restore') throw new Error('unsafe-restore-target')
  const manifest = JSON.parse(await readFile(path.join(directory, 'backup-manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.mode !== 'synthetic-disposable') throw new Error('unsupported-backup-manifest')
  assert.deepEqual(manifest.authenticatedMetadata, { schemaVersion: manifest.schemaVersion, mode: manifest.mode, source: manifest.source, plaintextBytes: manifest.plaintextBytes })
  const encrypted = await readFile(path.join(directory, 'backup.enc'))
  const dump = decryptArchive(encrypted, process.env.STAGING_BACKUP_PASSPHRASE, manifest)
  assert.equal(dump.length, manifest.plaintextBytes)
  const restoreTarget = await assertEmptyRestoreTarget(process.env.RESTORE_DATABASE_URL)
  await postgresClient(process.env.RESTORE_DATABASE_URL, { name: 'pg_restore', args: ['--no-owner', '--no-acl', '--exit-on-error', '--clean', '--if-exists'] }, { input: dump, maxOutput: 16_384 })
  const restored = await syntheticSnapshot(process.env.RESTORE_DATABASE_URL)
  assert.equal(restored.database, restoreTarget.database)
  assert.equal(restored.oid, restoreTarget.oid)
  assert.deepEqual(restored.ledger, manifest.source.ledger)
  assert.equal(restored.tableCount, manifest.source.tableCount)
  assert.equal(restored.fixtureCount, manifest.source.fixtureCount)
  assert.equal(restored.fixtureFingerprint, manifest.source.fixtureFingerprint)
  const proof = { schemaVersion: 1, mode: 'synthetic-disposable', verifiedAt: new Date().toISOString(), archiveSha256: manifest.archiveSha256, source: manifest.source, restored, dumpSha256: sha256(dump), ok: true }
  await writeFile(path.join(directory, 'restore-proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ ok: true, mode: proof.mode, archiveSha256: proof.archiveSha256, ledgerCount: restored.ledger.length, tableCount: restored.tableCount, fixtureCount: restored.fixtureCount })}\n`)
} catch {
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'synthetic-restore-failed' })}\n`)
  process.exitCode = 1
}
