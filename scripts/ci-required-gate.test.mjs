import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { evaluateGate } from './lib/ci-required-gate.mjs'

const gateScript = fileURLToPath(new URL('./ci-required-gate.mjs', import.meta.url))

const ok = { result: 'success' }
const needs = (overrides = {}, outputs = { mode: 'scoped', run_visitor_launch: 'true' }) => ({
  plan: { result: 'success', outputs },
  ci: ok,
  'railway-iac': ok,
  'visitor-launch': ok,
  ...overrides,
})

test('passes when every required job succeeded', () => {
  assert.equal(evaluateGate(needs()).ok, true)
})

test('passes when visitor-launch is skipped only because the plan legitimately excluded it', () => {
  const verdict = evaluateGate(
    needs(
      { 'visitor-launch': { result: 'skipped' } },
      { mode: 'docs-only', run_visitor_launch: 'false' },
    ),
  )
  assert.equal(verdict.ok, true)
  assert.match(verdict.notes.join(' '), /visitor-launch skipped by the change plan/u)
})

test('a skipped visitor-launch fails when the plan required it or the plan is FULL', () => {
  assert.equal(
    evaluateGate(
      needs(
        { 'visitor-launch': { result: 'skipped' } },
        { mode: 'scoped', run_visitor_launch: 'true' },
      ),
    ).ok,
    false,
  )
  assert.equal(
    evaluateGate(
      needs(
        { 'visitor-launch': { result: 'skipped' } },
        { mode: 'full', run_visitor_launch: 'false' },
      ),
    ).ok,
    false,
  )
  assert.equal(evaluateGate(needs({ 'visitor-launch': { result: 'skipped' } }, {})).ok, false)
})

test('failed, cancelled, skipped or missing required jobs fail the gate', () => {
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    for (const job of ['plan', 'ci', 'railway-iac']) {
      const verdict = evaluateGate(needs({ [job]: result ? { result } : undefined }))
      assert.equal(verdict.ok, false, `${job}:${result}`)
    }
    assert.equal(
      evaluateGate(needs({ 'visitor-launch': result ? { result } : undefined })).ok,
      false,
    )
  }
})

test('a failed plan job fails the gate even when the fallback full suite passed', () => {
  assert.equal(evaluateGate(needs({ plan: { result: 'failure', outputs: {} } })).ok, false)
})

test('unreadable needs context fails closed', () => {
  assert.equal(evaluateGate(null).ok, false)
  assert.equal(evaluateGate('x').ok, false)
})

test('CLI exits non-zero on failure and on malformed input, zero on success', () => {
  const run = (value) =>
    spawnSync(process.execPath, [gateScript], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, NEEDS_JSON: value },
    })
  assert.equal(run(JSON.stringify(needs())).status, 0)
  assert.equal(run(JSON.stringify(needs({ ci: { result: 'failure' } }))).status, 1)
  assert.equal(run('not json').status, 1)
  assert.equal(run('').status, 1)
})
