import assert from 'node:assert/strict'
import test from 'node:test'
import { safeErrorCode } from './error-code.mjs'

test('only fixed diagnostic codes reach logs', () => {
  assert.equal(safeErrorCode(new Error('artifact-binding-mismatch'), ['artifact-binding-mismatch'], 'restore-failed'), 'artifact-binding-mismatch')
  assert.equal(safeErrorCode(new Error('connection to postgresql://private failed'), ['artifact-binding-mismatch'], 'restore-failed'), 'restore-failed')
})
