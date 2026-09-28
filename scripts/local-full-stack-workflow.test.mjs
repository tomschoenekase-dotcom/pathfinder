import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflow = await readFile(resolve(root, '.github/workflows/local-full-stack.yml'), 'utf8')

function indexOf(text) {
  const index = workflow.indexOf(text)
  assert.notEqual(index, -1, `Workflow is missing: ${text}`)
  return index
}

test('local full-stack workflow is opt-in and least-privilege', () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:\s*$/mu)
  assert.match(workflow, /^permissions:\n  contents: read\s*$/mu)
  assert.match(workflow, /runs-on: ubuntu-latest/u)
  assert.match(workflow, /timeout-minutes: (?:[1-5]?\d|60)\s*$/mu)
  assert.match(workflow, /actions\/checkout@[a-f0-9]{40}[\s\S]*?persist-credentials: false/u)
  assert.match(workflow, /pnpm\/action-setup@[a-f0-9]{40}/u)
  assert.match(workflow, /actions\/setup-node@[a-f0-9]{40}/u)
  assert.doesNotMatch(workflow, /\bsecrets\./iu)
  assert.doesNotMatch(workflow, /^\s+services:\s*$/mu)
  assert.doesNotMatch(workflow, /\b(?:railway|clerk|stripe|openai)\s+(?:login|deploy|auth|api)\b/iu)

  const jobEnvironment = workflow.match(/^    env:\n((?:      .*\n)+)/mu)?.[1]
  assert.ok(jobEnvironment, 'Job-level environment block should exist')
  assert.doesNotMatch(jobEnvironment, /runner\.temp/u)
  assert.equal(
    [...workflow.matchAll(/TORCHIKO_LOCAL_FULL_STACK_ROOT: \$\{\{ runner\.temp \}\}\/MachineWorkspaces\/torchiko\/20260928-local-full-stack/gu)].length,
    4,
    'runner.temp owner root should be scoped to reset, up, network verification, and down steps',
  )
  for (const step of ['Reset local full stack', 'Start local full stack', 'Verify local network boundaries', 'Stop local full stack']) {
    const start = indexOf(`- name: ${step}`)
    const end = workflow.indexOf('\n      - ', start + 1)
    const stepText = workflow.slice(start, end === -1 ? undefined : end)
    assert.ok(stepText.includes('TORCHIKO_LOCAL_FULL_STACK_ROOT: ${{ runner.temp }}/MachineWorkspaces/torchiko/20260928-local-full-stack'))
  }
})

test('workflow resets and starts the pinned local stack before M3 and M4', () => {
  const reset = indexOf('run: pnpm local:reset')
  const up = indexOf('run: pnpm local:up')
  const networkProof = indexOf('run: node scripts/local-full-stack-network-proof.mjs')
  const authConfig = indexOf('node --test scripts/local-fixture-auth-config.test.mjs')
  const authUnit = indexOf('src/local-fixture/guard.test.ts src/local-fixture/edge.test.ts')
  const webBuild = indexOf('pnpm --dir apps/web build')
  const dashboardBuild = indexOf('pnpm --dir apps/dashboard build')
  const bundle = indexOf('node scripts/verify-local-fixture-auth-bundle.mjs')
  const refusal = indexOf('Verify production builds refuse fixture auth')
  const journeys = indexOf('Run local full-stack journeys three times')

  assert.ok(reset < up && up < networkProof && networkProof < authConfig && authConfig < authUnit)
  assert.match(workflow, /run: pnpm local:up\n      - name: Verify local network boundaries\n        env:\n          TORCHIKO_LOCAL_FULL_STACK_ROOT: \$\{\{ runner\.temp \}\}\/MachineWorkspaces\/torchiko\/20260928-local-full-stack\n        run: node scripts\/local-full-stack-network-proof\.mjs/u)
  assert.ok(authUnit < webBuild && webBuild < dashboardBuild)
  assert.ok(dashboardBuild < bundle && bundle < refusal && refusal < journeys)
  assert.match(workflow, /NEXT_DIST_DIR: \.next-p14-ci-build/u)
  assert.match(workflow, /NEXT_FONT_GOOGLE_MOCKED_RESPONSES: \$\{\{ github\.workspace \}\}\/scripts\/local-font-mocks\.cjs/u)
  assert.match(workflow, /NEXT_TELEMETRY_DISABLED: '1'/u)
  assert.match(workflow, /Local fixture authentication is forbidden outside development/u)
})

test('journeys use the running local endpoints and pass three serial times', () => {
  assert.match(workflow, /PLAYWRIGHT_DASHBOARD_BASE_URL: http:\/\/127\.0\.0\.1:56346/u)
  assert.match(workflow, /PLAYWRIGHT_VISITOR_BASE_URL: http:\/\/127\.0\.0\.1:56345/u)
  assert.match(workflow, /for run in 1 2 3/u)
  assert.match(workflow, /playwright test --config playwright\.visual\.config\.ts tests\/visual\/local-full-stack\.spec\.ts --project phone-390x844 --retries=0/u)
})

test('stack cleanup is the final unconditional step', () => {
  const cleanup = workflow.lastIndexOf('- name: Stop local full stack')
  assert.notEqual(cleanup, -1)
  assert.match(workflow.slice(cleanup), /if: always\(\)[\s\S]*?run: pnpm local:down\s*$/u)
})
