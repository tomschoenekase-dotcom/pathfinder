import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { safeErrorCode } from './error-code.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const exactSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
const hex256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)

function argsMap(args) {
  if (args.length % 2) throw new Error('invalid-evidence-arguments')
  const out = new Map()
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || out.has(args[i]) || !args[i + 1]) throw new Error('invalid-evidence-arguments')
    out.set(args[i], args[i + 1])
  }
  return out
}

function digestPayload(payload) {
  const { integritySha256, ...unsigned } = payload
  return sha256(JSON.stringify(unsigned))
}

function validSnapshot(snapshot, database) {
  const oid = snapshot?.oid
  const validOid = Number.isSafeInteger(oid) && oid > 0 ||
    typeof oid === 'string' && /^[1-9][0-9]*$/u.test(oid) && Number.isSafeInteger(Number(oid))
  return snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot) &&
    snapshot.database === database && validOid &&
    Array.isArray(snapshot.ledger) && snapshot.ledger.length > 0 &&
    snapshot.ledger.every((item) => typeof item === 'string' && /^[a-z0-9_]+$/u.test(item)) &&
    Number.isSafeInteger(snapshot.tableCount) && snapshot.tableCount >= 2 &&
    Number.isSafeInteger(snapshot.fixtureCount) && snapshot.fixtureCount >= 1 &&
    typeof snapshot.fixtureFingerprint === 'string' && /^[a-f0-9]{32}$/u.test(snapshot.fixtureFingerprint)
}

function samePreservationFacts(source, restored) {
  return source.ledger.length === restored.ledger.length &&
    source.ledger.every((item, index) => item === restored.ledger[index]) &&
    source.tableCount === restored.tableCount &&
    source.fixtureCount === restored.fixtureCount &&
    source.fixtureFingerprint === restored.fixtureFingerprint
}

function validate(payload, releaseSha) {
  if (payload?.schemaVersion !== 1 || payload?.type !== 'one-click-staging-synthetic' || payload?.mode !== 'synthetic-disposable' || payload?.admission !== 'synthetic-proof-only') throw new Error('wrong-evidence-type')
  if (!exactSha(releaseSha) || payload.releaseSha !== releaseSha) throw new Error('evidence-sha-mismatch')
  if (!hex256(payload.archiveSha256) || payload.restore?.archiveSha256 !== payload.archiveSha256 || payload.restore?.ok !== true) throw new Error('evidence-restore-mismatch')
  if (!validSnapshot(payload.source, 'pathfinder_disposable_source') || !validSnapshot(payload.restore, 'pathfinder_disposable_restore')) throw new Error('evidence-database-mismatch')
  if (!samePreservationFacts(payload.source, payload.restore)) throw new Error('evidence-preservation-mismatch')
  if (typeof payload.createdAt !== 'string' || !Number.isFinite(Date.parse(payload.createdAt)) || new Date(payload.createdAt).toISOString() !== payload.createdAt) throw new Error('evidence-timestamp-invalid')
  if (payload.provenance !== 'pending-github-oidc-attestation') throw new Error('evidence-provenance-invalid')
  if (!hex256(payload.integritySha256) || payload.integritySha256 !== digestPayload(payload)) throw new Error('evidence-integrity-mismatch')
  return { ok: true, type: payload.type, releaseSha }
}

async function main() {
  const options = argsMap(process.argv.slice(2))
  const releaseSha = options.get('--release-sha')
  if (!exactSha(releaseSha)) throw new Error('invalid-release-sha')
  if (options.has('--verify')) {
    if (options.size !== 2) throw new Error('invalid-evidence-arguments')
    const payload = JSON.parse(await readFile(options.get('--verify'), 'utf8'))
    return validate(payload, releaseSha)
  }
  if (options.size !== 4 || !['--backup-manifest', '--restore-proof', '--release-sha', '--output'].every((key) => options.has(key))) throw new Error('invalid-evidence-arguments')
  const backup = JSON.parse(await readFile(options.get('--backup-manifest'), 'utf8'))
  const proof = JSON.parse(await readFile(options.get('--restore-proof'), 'utf8'))
  if (backup.schemaVersion !== 1 || backup.mode !== 'synthetic-disposable' || proof.schemaVersion !== 1 || proof.mode !== 'synthetic-disposable' || proof.ok !== true || backup.archiveSha256 !== proof.archiveSha256) throw new Error('invalid-backup-proof')
  const payload = {
    schemaVersion: 1,
    type: 'one-click-staging-synthetic',
    mode: 'synthetic-disposable',
    admission: 'synthetic-proof-only',
    releaseSha,
    createdAt: new Date().toISOString(),
    archiveSha256: backup.archiveSha256,
    source: backup.source,
    restore: { ...proof.restored, archiveSha256: proof.archiveSha256, ok: true },
    provenance: 'pending-github-oidc-attestation',
  }
  payload.integritySha256 = digestPayload(payload)
  validate(payload, releaseSha)
  await writeFile(options.get('--output'), `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return { ok: true, type: payload.type, releaseSha, integritySha256: payload.integritySha256 }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
  const code = safeErrorCode(error, [
    'wrong-evidence-type', 'evidence-sha-mismatch', 'evidence-restore-mismatch',
    'evidence-database-mismatch', 'evidence-preservation-mismatch',
    'evidence-timestamp-invalid', 'evidence-provenance-invalid',
    'evidence-integrity-mismatch', 'invalid-backup-proof',
  ], 'one-click-evidence-failed')
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`)
  process.exitCode = 1
})
