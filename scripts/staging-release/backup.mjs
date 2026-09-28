import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { encryptArchive } from './archive.mjs'
import { postgresClient, syntheticSnapshot } from './postgres-client.mjs'

function outputDir(args) {
  if (args.length !== 2 || args[0] !== '--output-dir' || !args[1]) throw new Error('backup-output-dir-required')
  return path.resolve(args[1])
}

try {
  const directory = outputDir(process.argv.slice(2))
  const source = await syntheticSnapshot(process.env.DATABASE_URL)
  if (source.database !== 'pathfinder_disposable_source' || source.ledger.length !== 1 || source.ledger[0] !== 'synthetic_fixture_001') throw new Error('unadmitted-synthetic-source')
  const dump = await postgresClient(process.env.DATABASE_URL, { name: 'pg_dump', args: ['--format=custom', '--no-owner', '--no-acl'] })
  if (dump.length < 100) throw new Error('empty-database-dump')
  const authenticatedMetadata = { schemaVersion: 1, mode: 'synthetic-disposable', source, plaintextBytes: dump.length }
  const result = encryptArchive(dump, process.env.STAGING_BACKUP_PASSPHRASE, authenticatedMetadata)
  const manifest = {
    schemaVersion: 1,
    mode: 'synthetic-disposable',
    createdAt: new Date().toISOString(),
    source,
    authenticatedMetadata: result.authenticatedMetadata,
    encryption: result.encryption,
    archiveSha256: result.archiveSha256,
    plaintextBytes: dump.length,
  }
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'backup.enc'), result.encrypted, { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(directory, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ ok: true, mode: manifest.mode, archiveSha256: manifest.archiveSha256, source: manifest.source })}\n`)
} catch {
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'synthetic-backup-failed' })}\n`)
  process.exitCode = 1
}
