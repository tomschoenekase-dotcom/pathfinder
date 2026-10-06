#!/usr/bin/env node
import { evaluateGate, evaluateCoreGate } from './lib/ci-required-gate.mjs'
import { execFileSync } from 'node:child_process'

let needs
try {
  needs = JSON.parse(process.env.NEEDS_JSON ?? '')
} catch {
  needs = null
}
const args = process.argv.slice(2)
const validArgs = args.length === 0 || (args.length === 1 && args[0] === '--core')
let expectedTree
if (needs?.plan?.outputs?.mode === 'verified-tree') {
  try {
    expectedTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  } catch {
    expectedTree = undefined
  }
}
const verdict = validArgs
  ? args[0] === '--core'
    ? evaluateCoreGate(needs, { expectedTree })
    : evaluateGate(needs, { expectedTree })
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
