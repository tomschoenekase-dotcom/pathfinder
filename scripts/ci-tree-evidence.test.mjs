import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  FULL_JOB_NAMES,
  MAX_EVIDENCE_AGE_MS,
  validateTreeEvidence,
  validPlanTreeProof,
} from './lib/ci-tree-evidence.mjs'
import { readTreeArtifact } from './lib/ci-tree-artifact.mjs'
import { evaluateGate, evaluateCoreGate } from './lib/ci-required-gate.mjs'

const tree = 'a'.repeat(40)
const revision = 'b'.repeat(40)
const now = Date.parse('2026-10-05T23:00:00Z')
const recordedAt = new Date(now - 60_000).toISOString()
const repository = 'owner/repo'
function fixture() {
  return {
    repository,
    tree,
    workflowId: 3,
    now,
    evidence: {
      schemaVersion: 1,
      mode: 'full',
      repository,
      tree,
      revision,
      runId: 10,
      attempt: 2,
      recordedAt,
    },
    run: {
      id: 10,
      run_attempt: 2,
      workflow_id: 3,
      head_sha: revision,
      path: '.github/workflows/ci.yml',
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      repository: { full_name: repository },
      head_repository: { full_name: repository },
    },
    artifact: {
      expired: false,
      name: `ci-full-tree-${tree}-attempt-2`,
      size_in_bytes: 1200,
      created_at: recordedAt,
      workflow_run: { id: 10, head_sha: revision },
    },
    jobs: FULL_JOB_NAMES.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  }
}
test('only a complete successful same-repository full run qualifies the identical tree', () => {
  assert.equal(validateTreeEvidence(fixture()), true)
})
const mutations = {
  'different tree': (f) => {
    f.evidence.tree = revision
  },
  'different revision': (f) => {
    f.evidence.revision = tree
  },
  'different repository': (f) => {
    f.evidence.repository = 'attacker/fork'
  },
  'fork run': (f) => {
    f.run.head_repository.full_name = 'attacker/fork'
  },
  'wrong run repository': (f) => {
    f.run.repository.full_name = 'attacker/fork'
  },
  'wrong workflow': (f) => {
    f.run.workflow_id = 4
  },
  'different workflow path': (f) => {
    f.run.path = '.github/workflows/other.yml'
  },
  'different attempt': (f) => {
    f.run.run_attempt = 3
  },
  'different run': (f) => {
    f.evidence.runId = 11
  },
  'untrusted event': (f) => {
    f.run.event = 'pull_request_target'
  },
  'failed run': (f) => {
    f.run.conclusion = 'failure'
  },
  'cancelled run': (f) => {
    f.run.conclusion = 'cancelled'
  },
  'unfinished run': (f) => {
    f.run.status = 'in_progress'
  },
  'scoped run': (f) => {
    f.evidence.mode = 'scoped'
  },
  'reused run cannot renew evidence': (f) => {
    f.evidence.mode = 'verified-tree'
  },
  'missing matrix lane': (f) => {
    f.jobs.pop()
  },
  'extra job': (f) => {
    f.jobs.push({ name: 'unknown', status: 'completed', conclusion: 'success' })
  },
  'duplicated lane': (f) => {
    f.jobs[0] = f.jobs[1]
  },
  'skipped source check': (f) => {
    f.jobs[3].conclusion = 'skipped'
  },
  'failed source check': (f) => {
    f.jobs[3].conclusion = 'failure'
  },
  'unfinished source check': (f) => {
    f.jobs[3].status = 'in_progress'
  },
  'expired artifact': (f) => {
    f.artifact.expired = true
  },
  'oversized artifact': (f) => {
    f.artifact.size_in_bytes = 256_001
  },
  'invalid artifact size': (f) => {
    f.artifact.size_in_bytes = -1
  },
  'wrong artifact name': (f) => {
    f.artifact.name = 'other'
  },
  'artifact from earlier attempt': (f) => {
    f.artifact.name = `ci-full-tree-${tree}-attempt-1`
  },
  'wrong artifact run': (f) => {
    f.artifact.workflow_run.id = 11
  },
  'wrong artifact revision': (f) => {
    f.artifact.workflow_run.head_sha = tree
  },
  'stale evidence': (f) => {
    f.evidence.recordedAt = new Date(now - MAX_EVIDENCE_AGE_MS - 1).toISOString()
  },
  'future evidence': (f) => {
    f.evidence.recordedAt = new Date(now + 1).toISOString()
  },
  'invalid timestamp': (f) => {
    f.evidence.recordedAt = 'invalid'
  },
  'artifact timestamp mismatch': (f) => {
    f.artifact.created_at = new Date(now - 600_000).toISOString()
  },
}
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name}`, () => {
    const f = fixture()
    mutate(f)
    assert.equal(validateTreeEvidence(f), false)
  })
}

const proof = () => ({
  mode: 'verified-tree',
  reuse_verified: 'true',
  evidence_tree: tree,
  evidence_run_id: '10',
  evidence_recorded_at: recordedAt,
  run_visitor_launch: 'false',
  run_browser_gates: 'false',
  run_workspace_graph: 'false',
  run_database_integration: 'false',
  turbo_filters: '',
})
const needs = () => ({
  plan: { result: 'success', outputs: proof() },
  ci: { result: 'success' },
  'railway-iac': { result: 'success' },
  'policy-and-integration': { result: 'success' },
  'visitor-launch': { result: 'skipped' },
  'browser-gates': { result: 'skipped' },
  'workspace-checks': { result: 'skipped' },
})
test('aggregate requires verified source tree and fresh current policy/IaC/plan', () => {
  assert.equal(validPlanTreeProof(proof(), tree, now), true)
  const options = { expectedTree: tree, now }
  assert.equal(evaluateGate(needs(), options).ok, true)
  assert.equal(evaluateCoreGate(needs(), options).ok, true)
  for (const expectedTree of [undefined, revision])
    assert.equal(evaluateGate(needs(), { expectedTree, now }).ok, false)
  for (const job of ['plan', 'ci', 'railway-iac', 'policy-and-integration']) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      const n = needs()
      n[job].result = result
      assert.equal(evaluateGate(n, options).ok, false, `${job}:${result}`)
    }
  }
  for (const job of ['visitor-launch', 'browser-gates', 'workspace-checks']) {
    for (const result of ['failure', 'cancelled']) {
      const n = needs()
      n[job].result = result
      assert.equal(evaluateGate(n, options).ok, false)
    }
  }
  for (const flag of ['run_visitor_launch', 'run_browser_gates', 'run_workspace_graph']) {
    const n = needs()
    n.plan.outputs[flag] = 'true'
    assert.equal(evaluateGate(n, options).ok, false)
  }
  for (const change of [
    { reuse_verified: 'false' },
    { evidence_run_id: '' },
    { evidence_recorded_at: new Date(now - MAX_EVIDENCE_AGE_MS - 1).toISOString() },
  ]) {
    const n = needs()
    Object.assign(n.plan.outputs, change)
    assert.equal(evaluateGate(n, options).ok, false)
  }
})

const python = process.platform === 'win32' ? 'python' : 'python3'
function zip(entries) {
  return execFileSync(
    python,
    [
      '-c',
      `
import io,json,sys,zipfile
out=io.BytesIO()
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 for name,content in json.loads(sys.stdin.read()): z.writestr(name,content)
sys.stdout.buffer.write(out.getvalue())
`,
    ],
    { input: JSON.stringify(entries), stdio: ['pipe', 'pipe', 'pipe'] },
  )
}
test('actual ZIP subprocess parses only the one bounded expected JSON entry', () => {
  assert.deepEqual(
    readTreeArtifact(zip([['ci-tree-evidence.json', JSON.stringify(fixture().evidence)]]), python),
    fixture().evidence,
  )
  for (const entries of [
    [['../ci-tree-evidence.json', '{}']],
    [
      ['ci-tree-evidence.json', '{}'],
      ['extra.json', '{}'],
    ],
    [
      ['ci-tree-evidence.json', '{}'],
      ['ci-tree-evidence.json', '{}'],
    ],
    [['ci-tree-evidence.json', 'x'.repeat(256_001)]],
    [['ci-tree-evidence.json', 'not json']],
  ])
    assert.throws(() => readTreeArtifact(zip(entries), python))
  assert.throws(() => readTreeArtifact(Buffer.alloc(256_001), python))
})

const scripts = fileURLToPath(new URL('.', import.meta.url))
test('manual and merge-queue lookup always falls back, without calling GitHub', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'torchiko-ci-proof-'))
  const output = path.join(dir, 'output')
  try {
    for (const event of ['workflow_dispatch', 'merge_group', 'unknown']) {
      writeFileSync(output, '')
      const result = spawnSync(
        process.execPath,
        [path.join(scripts, 'find-ci-tree-evidence.mjs')],
        { encoding: 'utf8', env: { GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output } },
      )
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(output, 'utf8'), 'verified=false\n')
    }
  } finally {
    unlinkSync(output)
    rmdirSync(dir)
  }
})

test('full evidence writer refuses scoped, incomplete, failed or filtered qualification', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'torchiko-ci-record-'))
  const output = path.join(dir, 'output')
  const fullNeeds = Object.fromEntries(
    Object.keys(needs()).map((name) => [name, { result: 'success' }]),
  )
  fullNeeds.plan.outputs = {
    mode: 'full',
    run_visitor_launch: 'true',
    run_database_integration: 'true',
    run_browser_gates: 'true',
    run_workspace_graph: 'true',
    turbo_filters: '',
  }
  try {
    for (const mutate of [
      (n) => {
        n.plan.outputs.mode = 'scoped'
      },
      (n) => {
        delete n.ci
      },
      (n) => {
        n['workspace-checks'].result = 'failure'
      },
      (n) => {
        n.plan.outputs.run_workspace_graph = 'false'
      },
      (n) => {
        n.plan.outputs.turbo_filters = '--filter=@pathfinder/api'
      },
    ]) {
      const n = structuredClone(fullNeeds)
      mutate(n)
      const result = spawnSync(
        process.execPath,
        [path.join(scripts, 'record-ci-tree-evidence.mjs')],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            NEEDS_JSON: JSON.stringify(n),
            RUNNER_TEMP: dir,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: repository,
            GITHUB_RUN_ID: '10',
            GITHUB_RUN_ATTEMPT: '1',
          },
        },
      )
      assert.equal(result.status, 1)
    }
    const result = spawnSync(
      process.execPath,
      [path.join(scripts, 'record-ci-tree-evidence.mjs')],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          NEEDS_JSON: JSON.stringify(fullNeeds),
          RUNNER_TEMP: dir,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: repository,
          GITHUB_RUN_ID: '10',
          GITHUB_RUN_ATTEMPT: '1',
        },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, 'ci-tree-evidence.json'), 'utf8')).mode,
      'full',
    )
  } finally {
    for (const filename of ['output', 'ci-tree-evidence.json']) {
      try {
        unlinkSync(path.join(dir, filename))
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
    }
    rmdirSync(dir)
  }
})

test('workflow carries qualified proof and cannot publish evidence from selective or reused runs', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  for (const field of [
    'reuse_verified',
    'evidence_tree',
    'evidence_run_id',
    'evidence_recorded_at',
  ])
    assert.ok(workflow.includes(`${field}: \${{ steps.reuse.outputs.${field} }}`))
  assert.match(workflow, /actions: read/u)
  assert.match(workflow, /run: node scripts\/find-ci-tree-evidence\.mjs/u)
  assert.match(workflow, /run: node scripts\/record-ci-tree-evidence\.mjs/u)
  assert.equal(
    (workflow.match(/if: \$\{\{ needs\.plan\.outputs\.mode == 'full' \}\}/gu) ?? []).length,
    2,
  )
  assert.match(workflow, /if-no-files-found: error/u)
  assert.match(
    workflow,
    /name: ci-full-tree-\$\{\{ steps\.tree-evidence\.outputs\.tree \}\}-attempt-\$\{\{ github\.run_attempt \}\}/u,
  )
})
