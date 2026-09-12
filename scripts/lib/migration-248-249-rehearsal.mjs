import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const FINAL_MIGRATION = '20260912080000_add_guest_conversation_disposition'

export function assertPreserved(before, after) {
  assert.deepEqual(after.rows, before.rows, 'Old column values/counts changed')
  assert.deepEqual(after.sequences, before.sequences, 'Old sequence state/properties changed')
  assert.deepEqual(after.ledger.slice(0, 248), before.ledger, 'Old ledger identities changed')
  assert.equal(before.ledger.length, 248)
  assert.equal(after.ledger.length, 249)
  assert.equal(after.ledger.at(-1).migration_name, FINAL_MIGRATION)
  assert.equal(after.tables, 265)
  assert.equal(before.tables, 264)
  assert.equal(after.newOperations, 0)
  assert.equal(after.nonNullDisposition, 0)
  assert.equal(after.invalidIndexes, 0)
  assert.equal(after.unvalidatedConstraints, 0)
}

export function quoteIdentifier(value) {
  assert.equal(typeof value, 'string')
  assert(value.length > 0 && !value.includes('\0'))
  return `"${value.replaceAll('"', '""')}"`
}
