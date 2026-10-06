import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n')
const job = (name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  assert.ok(start >= 0, `missing job ${name}`)
  const rest = workflow.slice(start + 1)
  const end = rest.slice(1).search(/\n  [a-z][a-z-]*:\n/u)
  return end < 0 ? rest : rest.slice(0, end + 1)
}

test('heavy gates start independently after the same change plan', () => {
  for (const name of ['policy-and-integration', 'browser-gates', 'workspace-checks']) {
    assert.match(job(name), /needs: plan\n/u)
    assert.doesNotMatch(job(name), /needs: \[/u)
    assert.match(job(name), /pnpm install --frozen-lockfile/u)
    assert.match(job(name), /persist-credentials: false/u)
    assert.match(job(name), /packages\/db db:generate/u)
  }
})

test('visual shards partition all tests across three isolated runners without fail-fast', () => {
  const browser = job('browser-gates')
  assert.match(browser, /fail-fast: false/u)
  assert.match(browser, /shard: \[1\/3, 2\/3, 3\/3\]/u)
  assert.match(browser, /VISUAL_SHARD: \$\{\{ matrix.shard \}\}/u)
  assert.match(browser, /pnpm test:visual-browser --shard="\$VISUAL_SHARD"/u)
  assert.doesNotMatch(browser, /--grep|--project|--workers|--retries/u)
})

test('policy, database and bundle gates remain required in their original environment', () => {
  const policy = job('policy-and-integration')
  for (const command of [
    'pnpm audit:prod',
    'pnpm verify:staging',
    'pnpm verify:client-bundles',
    'pnpm test:browser-foundation',
    'pnpm test:accessibility',
    'pnpm test:scripts',
    'pnpm db:migrate:disposable',
    'pnpm test:redis:queue-observability',
  ]) {
    assert.ok(policy.includes(command), command)
  }
})

test('workspace checks retain typecheck, lint and the complete test graph', () => {
  const workspace = job('workspace-checks')
  assert.match(workspace, /pnpm turbo run typecheck \$PLAN_TURBO_FILTERS/u)
  assert.match(workspace, /pnpm turbo run lint \$PLAN_TURBO_FILTERS/u)
  assert.match(workspace, /node scripts\/run-ci-workspace-tests.mjs/u)
  assert.match(workspace, /pnpm db:migrate:disposable/u)
})

test('workspace tests start independently of types and both lanes remain required', () => {
  const workspace = job('workspace-checks')
  assert.match(workspace, /fail-fast: false/u)
  assert.match(workspace, /lane: \[types-and-lint, tests\]/u)
  for (const step of ['Run pnpm turbo run typecheck', 'Run pnpm turbo run lint']) {
    const start = workspace.indexOf(`- name: ${step}`)
    assert.ok(start >= 0)
    const condition = workspace.slice(start).split('\n')[1]
    assert.ok(condition.includes("matrix.lane == 'types-and-lint'"))
    assert.ok(condition.includes("needs.plan.outputs.run_workspace_graph != 'false'"))
  }
  const start = workspace.indexOf('- name: Verify workspace test graph')
  const condition = workspace.slice(start).split('\n')[1]
  assert.ok(condition.includes("matrix.lane == 'tests'"))
  assert.ok(condition.includes("needs.plan.outputs.run_workspace_graph != 'false'"))
  // GitHub reduces a matrix dependency to failure unless every lane succeeds.
  assert.match(job('ci'), /browser-gates, workspace-checks\]/u)
  assert.match(job('ci-required'), /workspace-checks/u)
})

test('existing protected ci check and final aggregate wait for every parallel gate', () => {
  assert.match(
    job('ci'),
    /needs: \[plan, policy-and-integration, browser-gates, workspace-checks\]/u,
  )
  assert.match(job('ci'), /node scripts\/ci-required-gate.mjs --core/u)
  const dependencies = job('ci-required')
    .match(/needs:\s*\[([\s\S]*?)\]/u)?.[1]
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  assert.deepEqual(dependencies, [
    'plan',
    'ci',
    'railway-iac',
    'visitor-launch',
    'policy-and-integration',
    'browser-gates',
    'workspace-checks',
  ])
  assert.match(job('ci-required'), /if: \$\{\{ always\(\) \}\}/u)
})
