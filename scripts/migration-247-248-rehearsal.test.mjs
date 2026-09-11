import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FINAL_COUNT,
  NEW_ENUM_LABEL,
  OLD_ENUM_LABELS,
  PREDECESSOR_COUNT,
  assertEnumTransition,
  assertLedger,
  parseArgs,
  sha256,
} from './lib/migration-247-248-rehearsal.mjs'

test('requires an explicit local native PostgreSQL root and dedicated loopback port', () => {
  const args = ['--native-root', process.cwd(), '--port', '55518']
  assert.deepEqual(parseArgs(args).port, '55518')
  for (const invalid of [[], args.slice(0, -2), [...args, '--database', 'production']])
    assert.throws(() => parseArgs(invalid))
})

test('requires a strictly additive enum and ledger transition', () => {
  const before = OLD_ENUM_LABELS.map((label, index) => ({ label, order: index + 1 }))
  const after = [...before, { label: NEW_ENUM_LABEL, order: 6 }]
  assert.doesNotThrow(() => assertEnumTransition(before, after))
  assert.throws(() =>
    assertEnumTransition(before, [...after.slice(0, 2), after[3], after[2], after[4], after[5]]),
  )

  const predecessor = Array.from({ length: PREDECESSOR_COUNT }, (_, index) => ({
    migration_name: `m${index}`,
    checksum: `c${index}`,
    finished_at: '2026-09-11T00:00:00.000Z',
    rolled_back_at: null,
  }))
  const migration248 = { sha256: 'new' }
  const afterLedger = [
    ...predecessor,
    {
      migration_name: '20260911063000_add_native_venue_bot_configuration_effect',
      checksum: migration248.sha256,
      finished_at: '2026-09-11T00:00:00.000Z',
      rolled_back_at: null,
    },
  ]
  assert.equal(afterLedger.length, FINAL_COUNT)
  assert.doesNotThrow(() =>
    assertLedger(predecessor, afterLedger, sha256(JSON.stringify(predecessor)), migration248),
  )
  assert.throws(() =>
    assertLedger(
      predecessor,
      [...afterLedger.slice(0, -1)],
      sha256(JSON.stringify(predecessor)),
      migration248,
    ),
  )
})
