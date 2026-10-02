import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

function jobBlock(name) {
  const match = workflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:\\n|(?![\\s\\S]))`, 'mu'),
  )
  assert.ok(match, `job ${name} must exist`)
  return match[1]
}

function steps(block) {
  return block.split(/^(?=      - )/mu).filter((step) => step.startsWith('      - '))
}

test('required job names are unchanged and the aggregate gate exists', () => {
  for (const name of ['plan', 'railway-iac', 'visitor-launch', 'ci', 'ci-required']) jobBlock(name)
})

test('ci and visitor-launch are never skipped by a failed or missing plan', () => {
  assert.match(jobBlock('ci'), /^    if: \$\{\{ !cancelled\(\) \}\}$/mu)
  assert.match(
    jobBlock('visitor-launch'),
    /^    if: \$\{\{ !cancelled\(\) && needs\.plan\.outputs\.run_visitor_launch != 'false' \}\}$/mu,
  )
  assert.doesNotMatch(jobBlock('railway-iac'), /^    (if|needs):/mu)
})

test('every plan-driven condition skips only on an explicit false', () => {
  const conditions = [...workflow.matchAll(/needs\.plan\.outputs\.(\w+) ([!=]=) '(\w+)'/gu)]
  assert.ok(conditions.length > 20)
  for (const [, , operator, value] of conditions) {
    assert.equal(operator, '!=')
    assert.equal(value, 'false')
  }
})

test('static policy checks and script tests are unconditional in the ci job', () => {
  const unconditional = [
    'pnpm audit:prod',
    'pnpm verify:staging',
    'pnpm verify:public-surfaces',
    'pnpm verify:ai-boundary',
    'pnpm verify:ai-budget',
    'pnpm verify:tenant-registry',
    'pnpm verify:tenant-bypasses',
    'pnpm verify:raw-sql',
    'pnpm verify:tenant-procedures',
    'pnpm verify:docker-context',
    'pnpm test:scripts',
    'scripts/staging-health-admission.test.mjs',
    'scripts/staging-widget-admission.test.mjs',
  ]
  const ciSteps = steps(jobBlock('ci'))
  for (const command of unconditional) {
    const step = ciSteps.find((candidate) => candidate.includes(command))
    assert.ok(step, command)
    assert.doesNotMatch(step, /^        if:/mu, `${command} must not be skippable`)
  }
})

test('release-bearing runs are forced to the full suite in YAML, independent of the classifier', () => {
  const forced = workflow.match(/- name: Force the full suite[\s\S]*?\n        run:/u)?.[0]
  assert.ok(forced)
  assert.match(forced, /github\.event_name != 'pull_request' && github\.event_name != 'push'/u)
  assert.match(forced, /github\.ref == 'refs\/heads\/master'/u)
  assert.match(forced, /github\.ref == 'refs\/heads\/codex\/pathfinder-v2-staging'/u)
  assert.match(forced, /github\.head_ref == 'codex\/pathfinder-v2-staging'/u)
  assert.match(forced, /github\.base_ref != 'master'/u)
  for (const output of [
    'mode=full',
    'run_visitor_launch=true',
    'run_database_integration=true',
    'run_browser_gates=true',
    'run_workspace_graph=true',
    'turbo_filters=',
  ]) {
    assert.ok(forced.includes(output) || workflow.includes(`echo '${output}'`), output)
  }
  const classify = workflow.match(
    /- name: Classify the complete change set[\s\S]*?continue-on-error/u,
  )?.[0]
  assert.match(classify ?? '', /if: \$\{\{ !\(/u)
})

test('merge queues and manual runs trigger CI and are never cancelled', () => {
  assert.match(workflow, /^  merge_group:$/mu)
  assert.match(workflow, /^  workflow_dispatch:$/mu)
  const cancel = workflow.match(/^  cancel-in-progress: (.*)$/mu)?.[1]
  assert.ok(cancel)
  for (const guarded of [
    "github.event_name != 'merge_group'",
    "github.event_name != 'workflow_dispatch'",
    "github.ref != 'refs/heads/master'",
    "github.ref != 'refs/heads/codex/pathfinder-v2-staging'",
    "github.head_ref != 'codex/pathfinder-v2-staging'",
  ]) {
    assert.ok(cancel.includes(guarded), guarded)
  }
})

test('the aggregate gate always runs and depends on every required job', () => {
  const gate = jobBlock('ci-required')
  assert.match(gate, /^    needs: \[plan, ci, railway-iac, visitor-launch\]$/mu)
  assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/mu)
  assert.match(gate, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/u)
  assert.match(gate, /run: node scripts\/ci-required-gate\.mjs/u)
})

test('turbo filters reach only validated command arguments', () => {
  assert.match(workflow, /PLAN_TURBO_FILTERS: \$\{\{ needs\.plan\.outputs\.turbo_filters \}\}/u)
  assert.match(workflow, /run: pnpm turbo run typecheck \$PLAN_TURBO_FILTERS/u)
  assert.match(workflow, /run: pnpm turbo run lint \$PLAN_TURBO_FILTERS/u)
  assert.doesNotMatch(workflow, /run:[^\n]*\$\{\{ needs\.plan/u)
})
