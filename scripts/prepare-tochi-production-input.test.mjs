import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { verifyReferenceBytes } from './prepare-tochi-production-input.mjs'

test('Tochi production input rejects a substituted reference board', () => {
  const expected = Buffer.from('approved-reference')
  const brief = {
    approvedReference: {
      sha256: createHash('sha256').update(expected).digest('hex'),
      byteLength: expected.byteLength,
    },
  }
  assert.equal(verifyReferenceBytes(brief, expected), brief.approvedReference.sha256)
  assert.throws(
    () => verifyReferenceBytes(brief, Buffer.from('different-reference')),
    /hash mismatch/u,
  )
})
