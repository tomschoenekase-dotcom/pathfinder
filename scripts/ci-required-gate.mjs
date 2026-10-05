#!/usr/bin/env node
import { evaluateGate, evaluateCoreGate } from './lib/ci-required-gate.mjs'

let needs
try {
  needs = JSON.parse(process.env.NEEDS_JSON ?? '')
} catch {
  needs = null
}
const args = process.argv.slice(2)
const validArgs = args.length === 0 || (args.length === 1 && args[0] === '--core')
const verdict = validArgs
  ? args[0] === '--core'
    ? evaluateCoreGate(needs)
    : evaluateGate(needs)
  : { ok: false, notes: [], failures: ['invalid gate options'] }
for (const note of verdict.notes) process.stdout.write(`note: ${note}\n`)
if (verdict.ok) {
  process.stdout.write('ci-required: all required jobs passed or were legitimately planned out\n')
} else {
  for (const failure of verdict.failures) {
    process.stderr.write(`::error title=ci-required::${failure}\n`)
  }
  process.exitCode = 1
}
