import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'

export const PREDECESSOR = '6f76348bba6af9228d1e5cc34a7043840888c4ef'
export const PREDECESSOR_COUNT = 247
export const FINAL_COUNT = 248
export const OLD_ENUM_LABELS = [
  'VENUE',
  'PLACE',
  'KNOWLEDGE',
  'GENERALIZED_MODULE',
  'GENERALIZED_PUBLICATION',
]
export const NEW_ENUM_LABEL = 'VENUE_BOT_CONFIGURATION'

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export function parseArgs(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    assert(['--native-root', '--port'].includes(key), 'Unknown option')
    assert(value && parsed[key] === undefined, 'Missing or duplicate option')
    parsed[key] = value
  }
  assert(path.isAbsolute(parsed['--native-root'] ?? ''), 'Explicit absolute native root required')
  assert(
    /^\d{5}$/.test(parsed['--port'] ?? '') &&
      Number(parsed['--port']) >= 49152 &&
      Number(parsed['--port']) <= 65535,
    'Dedicated high loopback port required',
  )
  return { nativeRoot: path.resolve(parsed['--native-root']), port: parsed['--port'] }
}

export function assertOwnedPath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  assert(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'Path escapes owned proof root',
  )
}

export function assertEnumTransition(before, after) {
  assert.deepEqual(
    before.map((row) => row.label),
    OLD_ENUM_LABELS,
    'Predecessor enum labels changed before migration 248.',
  )
  assert.deepEqual(
    after.map((row) => row.label),
    [...OLD_ENUM_LABELS, NEW_ENUM_LABEL],
    'Migration 248 must append exactly one enum label.',
  )
  assert.deepEqual(
    after.slice(0, OLD_ENUM_LABELS.length),
    before,
    'Pre-existing enum labels or sort order changed.',
  )
  assert(after.at(-1).order > before.at(-1).order, 'New enum label was not appended.')
}

export function assertLedger(before, after, predecessorManifest, migration248) {
  assert.equal(before.length, PREDECESSOR_COUNT, 'Expected exact 247-migration predecessor.')
  assert.equal(after.length, FINAL_COUNT, 'Expected exactly one additive migration.')
  assert.deepEqual(
    after.slice(0, PREDECESSOR_COUNT),
    before,
    'Existing migration ledger rows changed.',
  )
  assert.equal(
    sha256(JSON.stringify(before)),
    predecessorManifest,
    'Unexpected predecessor ledger.',
  )
  assert.equal(
    after.at(-1)?.migration_name,
    '20260911063000_add_native_venue_bot_configuration_effect',
  )
  assert.equal(after.at(-1)?.checksum, migration248.sha256)
  assert(after.at(-1)?.finished_at, 'New migration did not finish.')
  assert.equal(after.at(-1)?.rolled_back_at, null)
}
