import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const needs = JSON.parse(process.env.NEEDS_JSON)
const expected = [
  'plan',
  'ci',
  'railway-iac',
  'visitor-launch',
  'policy-and-integration',
  'browser-gates',
  'workspace-checks',
]
if (
  Object.keys(needs).length !== expected.length ||
  expected.some((name) => needs[name]?.result !== 'success') ||
  needs.plan.outputs.mode !== 'full'
)
  throw new Error('full-success-required')
for (const flag of [
  'run_visitor_launch',
  'run_database_integration',
  'run_browser_gates',
  'run_workspace_graph',
]) {
  if (needs.plan.outputs[flag] !== 'true') throw new Error('full-plan-required')
}
if (needs.plan.outputs.turbo_filters !== '') throw new Error('unfiltered-full-plan-required')
const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const evidence = {
  schemaVersion: 1,
  mode: 'full',
  tree,
  revision,
  repository: process.env.GITHUB_REPOSITORY,
  runId: Number(process.env.GITHUB_RUN_ID),
  attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  recordedAt: new Date().toISOString(),
}
if (
  !/^[0-9a-f]{40}$/u.test(tree) ||
  !/^[0-9a-f]{40}$/u.test(revision) ||
  !Number.isSafeInteger(evidence.runId) ||
  evidence.runId < 1 ||
  !Number.isSafeInteger(evidence.attempt) ||
  evidence.attempt < 1
)
  throw new Error('invalid-run-binding')
const file = path.join(process.env.RUNNER_TEMP, 'ci-tree-evidence.json')
writeFileSync(file, `${JSON.stringify(evidence)}\n`, { flag: 'wx' })
appendFileSync(process.env.GITHUB_OUTPUT, `tree=${tree}\nfile=${file}\n`)
