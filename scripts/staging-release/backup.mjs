import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import { encryptArchiveStream } from './archive.mjs'
import { s3SinkFromEnvironment } from './archive-sink.mjs'
import { postgresClientStream, syntheticSnapshot } from './postgres-client.mjs'

function outputDir(args) {
  if (args.length !== 2 || args[0] !== '--output-dir' || !args[1]) throw new Error('backup-output-dir-required')
  return path.resolve(args[1])
}

function temporaryRoot(outputDirectory, rawRoot) {
  const root = path.resolve(rawRoot)
  const relative = path.relative(outputDirectory, root)
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('backup-temp-dir-overlaps-output')
  }
  return root
}

let temporaryDirectory
let archivePath
let dump
try {
  const directory = outputDir(process.argv.slice(2))
  const publicKey = process.env.STAGING_BACKUP_PUBLIC_KEY
  if (publicKey && !process.env.STAGING_ARCHIVE_S3_ENDPOINT) throw new Error('public-key-archive-requires-private-sink')
  const sink = s3SinkFromEnvironment()
  if ((sink || publicKey) && !process.env.STAGING_RELEASE_TMP) throw new Error('backup-temp-dir-required')
  const tempRoot = process.env.STAGING_RELEASE_TMP ? temporaryRoot(directory, process.env.STAGING_RELEASE_TMP) : null
  if (tempRoot) await mkdir(tempRoot, { recursive: true })
  const source = await syntheticSnapshot(process.env.DATABASE_URL)
  if (source.database !== 'pathfinder_disposable_source' || source.ledger.length !== 1 || source.ledger[0] !== 'synthetic_fixture_001') throw new Error('unadmitted-synthetic-source')
  temporaryDirectory = sink ? await mkdtemp(path.join(tempRoot, 'p13-staging-archive-')) : null
  const archiveDirectory = temporaryDirectory ?? directory
  await mkdir(directory, { recursive: true })
  archivePath = path.join(archiveDirectory, 'backup.enc')
  const archiveOutput = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
  dump = postgresClientStream(process.env.DATABASE_URL, { name: 'pg_dump', args: ['--format=custom', '--no-owner', '--no-acl'] })
  const authenticatedMetadata = { schemaVersion: 1, mode: 'synthetic-disposable', source }
  let result
  try {
    result = await encryptArchiveStream(
      dump.stream,
      (chunk) => new Promise((resolve, reject) => archiveOutput.write(chunk, (error) => error ? reject(new Error('backup-output-write-failed')) : resolve())),
      process.env.STAGING_BACKUP_PUBLIC_KEY
        ? { publicKey: process.env.STAGING_BACKUP_PUBLIC_KEY }
        : { passphrase: process.env.STAGING_BACKUP_PASSPHRASE, mode: 'synthetic-disposable' },
      authenticatedMetadata,
    )
    archiveOutput.end()
    await once(archiveOutput, 'close')
    await dump.completion
    if (result.plaintextBytes < 100) throw new Error('empty-database-dump')
  } catch (error) {
    dump.cancel()
    dump.stream.destroy()
    archiveOutput.destroy()
    await dump.completion.catch(() => {})
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    else await rm(archivePath, { force: true }).catch(() => {})
    throw error
  }
  const manifest = {
    schemaVersion: 1,
    mode: 'synthetic-disposable',
    createdAt: new Date().toISOString(),
    source,
    authenticatedMetadata: result.authenticatedMetadata,
    encryption: result.encryption,
    archiveSha256: result.archiveSha256,
    plaintextBytes: result.plaintextBytes,
  }
  if (sink) {
    const objectKey = `staging-backups/${result.archiveSha256}.backup.enc`
    const uploaded = await sink.putFile(archivePath, objectKey)
    manifest.archiveStorage = { kind: 'private-s3-compatible', key: uploaded.key, size: uploaded.size, sha256: uploaded.sha256 }
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  await writeFile(path.join(directory, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ ok: true, mode: manifest.mode, archiveSha256: manifest.archiveSha256, source: manifest.source })}\n`)
} catch (error) {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {})
  else if (archivePath) await rm(archivePath, { force: true }).catch(() => {})
  const codes = new Set(['backup-output-dir-required', 'backup-temp-dir-required', 'backup-temp-dir-overlaps-output', 'public-key-archive-requires-private-sink', 'invalid-disposable-database-url', 'unsafe-disposable-database-target', 'postgres-client-start-failed', 'postgres-client-failed', 'invalid-disposable-snapshot', 'unadmitted-synthetic-source', 'empty-database-dump', 'backup-passphrase-required', 'synthetic-passphrase-forbidden', 'invalid-backup-public-key', 'archive-encryption-failed', 'backup-output-write-failed', 'archive-sink-config-invalid', 'archive-sink-file-unavailable', 'archive-sink-key-invalid', 'archive-sink-auth-rejected', 'archive-sink-bucket-or-request-invalid', 'archive-sink-upload-failed'])
  const code = codes.has(error?.message) ? error.message : 'synthetic-backup-failed'
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`)
  process.exitCode = 1
}
