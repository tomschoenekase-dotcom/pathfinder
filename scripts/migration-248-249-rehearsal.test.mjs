import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPreserved,
  FINAL_MIGRATION,
  quoteIdentifier,
} from './lib/migration-248-249-rehearsal.mjs'

test('preservation rejects content, sequence and original ledger identity drift', () => {
  const before = {
    rows: [{ table: 'messages', count: 2, hash: 'fixture' }],
    sequences: [{ name: 'seq', value: 7 }],
    ledger: Array.from({ length: 248 }, (_, id) => ({ id })),
    tables: 264,
  }
  const after = {
    ...structuredClone(before),
    ledger: [...before.ledger, { migration_name: FINAL_MIGRATION }],
    tables: 265,
    newOperations: 0,
    nonNullDisposition: 0,
    invalidIndexes: 0,
    unvalidatedConstraints: 0,
  }
  assert.doesNotThrow(() => assertPreserved(before, after))
  for (const mutate of [
    (x) => (x.rows[0].hash = 'changed'),
    (x) => x.rows[0].count++,
    (x) => x.sequences[0].value++,
    (x) => (x.ledger[0].id = 'changed'),
    (x) => x.newOperations++,
    (x) => x.nonNullDisposition++,
  ]) {
    const changed = structuredClone(after)
    mutate(changed)
    assert.throws(() => assertPreserved(before, changed))
  }
})

test('catalogue names are quoted literally', () => {
  assert.equal(quoteIdentifier('a"b'), '"a""b"')
  assert.throws(() => quoteIdentifier('x\0y'))
})
