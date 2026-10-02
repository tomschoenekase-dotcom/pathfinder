#!/usr/bin/env node
import { evaluateGate } from './lib/ci-required-gate.mjs'

let needs
try {
  needs = JSON.parse(process.env.NEEDS_JSON ?? '')
} catch {
  needs = null
}
const verdict = evaluateGate(needs)
for (const note of verdict.notes) process.stdout.write(`note: ${note}\n`)
if (verdict.ok) {
  process.stdout.write('ci-required: all required jobs passed or were legitimately planned out\n')
} else {
  for (const failure of verdict.failures) {
    process.stderr.write(`::error title=ci-required::${failure}\n`)
  }
  process.exitCode = 1
}
