import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'

export const PREFIX = 236
export const FINAL = 247
export const MANIFEST = 'accc130b682f930408145bf38eb97e27488b183cf54884e8f78753760d5da82c'
export const PREDECESSOR = 'f4aebada18e395975ca24613b86caf3a93428d1f5c661e55ae446527130861a9'
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const manifestHash = (rows) => sha256(rows.map(row => `${row.name} ${row.normalizedSha256}\n`).join(''))
export function parseArgs(args) {
  const result = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    assert(['--candidate', '--native-root', '--port'].includes(name), 'Unknown option')
    assert(args[index + 1] && result[name] === undefined, 'Missing or duplicate option')
    result[name] = args[index + 1]
  }
  assert(/^[a-f0-9]{40}$/.test(result['--candidate'] ?? ''), 'Full candidate SHA required')
  assert(path.isAbsolute(result['--native-root'] ?? ''), 'Explicit absolute native root required')
  assert(/^\d{5}$/.test(result['--port'] ?? '') && Number(result['--port']) >= 49152 && Number(result['--port']) <= 65535, 'Dedicated high loopback port required')
  return { candidate: result['--candidate'], nativeRoot: path.resolve(result['--native-root']), port: result['--port'] }
}
export function assertOwnedPath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Path escapes owned proof root')
}
export function assertManifest(rows) {
  assert.equal(rows.length, FINAL, 'Expected exactly 247 migrations')
  assert.equal(rows[235].name, '20260908160000_add_agent_question_operations')
  assert.equal(rows[246].name, '20260910140000_add_semantic_reviewed_decline')
  assert.equal(manifestHash(rows.slice(0, PREFIX)), PREDECESSOR)
  assert.equal(manifestHash(rows), MANIFEST)
  assert.equal(new Set(rows.map(row => row.name)).size, FINAL)
}
export function assertPreserved(before, after) {
  const observations = []
  for (const [table, rows] of Object.entries(before)) {
    assert(Array.isArray(after[table]), `Missing table ${table}`)
    // Project the new rows onto the old columns so only explicitly added columns differ.
    const keys = rows.length ? Object.keys(rows[0]).sort() : []
    const canonical = values => values.map(row => JSON.stringify(Object.fromEntries(keys.map(key => [key, row[key]])))).sort()
    assert.deepEqual(canonical(after[table]), canonical(rows), `Retained data changed: ${table}`)
    observations.push({ table, countBefore: rows.length, countAfter: after[table].length, beforeSha256: sha256(JSON.stringify(canonical(rows))), afterProjectedSha256: sha256(JSON.stringify(canonical(after[table]))) })
  }
  return observations
}
export function assertSuccessfulResult(result) {
  assert.equal(result.error, undefined, 'A terminal error forbids successful proof emission')
  assert.equal(result.admissionFailure, undefined, 'A recorded admission failure forbids successful proof emission')
  for (const name of ['uninterrupted', 'critical', 'contradiction', 'corrected', 'restore']) {
    assert.equal(result.cases[name]?.passed, true, `Missing successful ${name} case`)
  }
  assert.equal(result.sourceHashesStable, true)
  assert.equal(result.migrationFilesystemHashesStable, true)
  assert.equal(result.executedSnapshotHashesStable, true)
  assert.equal(result.portReleased, true)
  assert.equal(result.stopped, true)
  assert.equal(result.failedFixturePreserved, true)
  assert.equal(result.candidate, result.migrationCandidate)
  assert.equal(result.cases.critical.deploy.waiting?.length, 1, 'Missing actual migration lock observation')
  assert.equal(result.cases.critical.concurrency?.records.length, 2, 'Missing isolation-level races')
}
