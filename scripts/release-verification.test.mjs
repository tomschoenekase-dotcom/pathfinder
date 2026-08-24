import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildReleaseGates,
  createReleaseProgressReporter,
  defaultCommandRunner,
  parseReleaseVerificationArgs,
  runReleaseVerification,
} from './lib/release-verification.mjs'

const SHA = 'a'.repeat(40)

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'torchiko-release-'))
  await mkdir(path.join(root, 'scripts'), { recursive: true })
  await writeFile(
    path.join(root, 'scripts/release-verification-policy.json'),
    JSON.stringify({
      schemaVersion: 1,
      staging: {
        healthUrl: 'https://staging.example.test/api/health',
        host: 'staging.example.test',
        resources: { database: 'db-staging', redis: 'redis-staging', storage: 'storage-staging' },
      },
      rollback: { application: 'redeploy', database: 'repair forward', runbook: 'docs/runbook.md' },
    }),
  )
  return root
}

test('argument parser is strict and staging requires an immutable revision', () => {
  assert.deepEqual(parseReleaseVerificationArgs([]), {
    profile: 'static',
    revision: undefined,
    report: undefined,
  })
  assert.throws(() => parseReleaseVerificationArgs(['--profile', 'other']), /invalid-profile/u)
  assert.throws(
    () => parseReleaseVerificationArgs(['--profile', 'staging']),
    /staging-revision-required/u,
  )
  assert.throws(() => parseReleaseVerificationArgs(['--other', 'x']), /unknown-option/u)
})

test('candidate profile is a strict superset of static release gates', () => {
  const staticIds = buildReleaseGates('static').map(([id]) => id)
  const candidateIds = buildReleaseGates('candidate').map(([id]) => id)
  assert.deepEqual(candidateIds.slice(0, staticIds.length), staticIds)
  assert.ok(staticIds.includes('repository-onboarding'))
  assert.ok(staticIds.includes('golden-venue-fixture'))
  assert.ok(candidateIds.includes('test'))
  assert.ok(candidateIds.includes('build'))
  assert.ok(candidateIds.includes('visual-browser'))
  assert.ok(candidateIds.includes('accessibility'))
})

test('default runner contains command startup failures as a failed gate', async () => {
  await expectCode(
    defaultCommandRunner('definitely-not-a-real-command', [], { cwd: process.cwd() }),
  )
})

test('progress reporter emits one prefixed JSON line without changing the event', () => {
  let output = ''
  const event = { schemaVersion: 1, event: 'gate-started', gateId: 'test' }
  createReleaseProgressReporter({ write: (value) => (output += value) })(event)
  assert.equal(output, `release-progress ${JSON.stringify(event)}\n`)
})

async function expectCode(resultPromise) {
  const result = await resultPromise
  assert.equal(result.code, 1)
}

test('clean static verification emits machine and founder-readable evidence', async () => {
  const root = await fixture()
  const calls = []
  const result = await runReleaseVerification({
    root,
    profile: 'static',
    repositoryState: async () => ({ revision: SHA, clean: true }),
    commandRunner: async (command, args) => {
      calls.push([command, ...args])
      return { code: 0 }
    },
    now: () => new Date('2026-08-22T12:00:00.000Z'),
  })
  assert.equal(result.report.readiness, 'static-preflight-passed')
  assert.equal(result.report.summary.failed, 0)
  assert.equal(calls.length, buildReleaseGates('static').length)
  assert.equal(JSON.parse(await readFile(result.jsonPath, 'utf8')).revision, SHA)
  assert.match(await readFile(result.markdownPath, 'utf8'), /static-preflight-passed/u)
})

test('verification stops at first failed gate and never claims readiness', async () => {
  const root = await fixture()
  let calls = 0
  const result = await runReleaseVerification({
    root,
    profile: 'candidate',
    repositoryState: async () => ({ revision: SHA, clean: true }),
    commandRunner: async () => ({ code: ++calls === 2 ? 1 : 0 }),
  })
  assert.equal(result.report.readiness, 'not-ready')
  assert.equal(result.report.summary.failed, 1)
  assert.equal(calls, 2)
})

test('verification reports ordered gate progress and heartbeats without changing failure policy', async () => {
  const root = await fixture()
  const events = []
  let activeHeartbeat
  let elapsedMs = 0
  const cleared = []
  const result = await runReleaseVerification({
    root,
    profile: 'static',
    repositoryState: async () => ({ revision: SHA, clean: true }),
    commandRunner: async () => {
      elapsedMs = 31_000
      activeHeartbeat()
      elapsedMs = 31_250
      return { code: 1 }
    },
    elapsedNow: () => elapsedMs,
    progressReporter: (event) => events.push(event),
    setIntervalImpl: (callback, interval) => {
      assert.equal(interval, 30_000)
      activeHeartbeat = callback
      return callback
    },
    clearIntervalImpl: (timer) => cleared.push(timer),
  })

  assert.equal(result.report.readiness, 'not-ready')
  assert.deepEqual(
    events.map(({ event, gateId, gateIndex, status }) => [event, gateId, gateIndex, status]),
    [
      ['verification-started', undefined, undefined, undefined],
      ['gate-started', 'clean-worktree', 1, undefined],
      ['gate-completed', 'clean-worktree', 1, 'pass'],
      ['gate-started', 'repository-onboarding', 2, undefined],
      ['gate-heartbeat', 'repository-onboarding', 2, undefined],
      ['gate-completed', 'repository-onboarding', 2, 'fail'],
      ['verification-completed', undefined, undefined, undefined],
    ],
  )
  assert.equal(events[4].elapsedMs, 31_000)
  assert.equal(events[5].elapsedMs, 31_250)
  assert.equal(events[0].totalGates, buildReleaseGates('static').length + 1)
  assert.equal(cleared.length, 2)
})

test('invalid heartbeat intervals fail before any release gate executes', async () => {
  const root = await fixture()
  let inspected = false
  await assert.rejects(
    runReleaseVerification({
      root,
      profile: 'static',
      heartbeatIntervalMs: 0,
      repositoryState: async () => {
        inspected = true
        return { revision: SHA, clean: true }
      },
    }),
    /invalid-heartbeat-interval/u,
  )
  assert.equal(inspected, false)
})

test('staging is blocked rather than green when exact hosted proof is unavailable', async () => {
  const root = await fixture()
  const result = await runReleaseVerification({
    root,
    profile: 'staging',
    requestedRevision: SHA,
    repositoryState: async () => ({ revision: SHA, clean: true }),
    commandRunner: async () => ({ code: 0 }),
    stagingVerifier: async () => {
      throw new Error('offline')
    },
  })
  assert.equal(result.report.readiness, 'not-ready')
  assert.equal(result.report.summary.blocked, 1)
  assert.equal(result.report.gates.at(-1).id, 'exact-staging-health')
})

test('dirty or mismatched revisions fail closed', async () => {
  const root = await fixture()
  const dirty = await runReleaseVerification({
    root,
    profile: 'static',
    repositoryState: async () => ({ revision: SHA, clean: false }),
    commandRunner: async () => ({ code: 0 }),
  })
  assert.equal(dirty.report.readiness, 'not-ready')
  await assert.rejects(
    runReleaseVerification({
      root,
      profile: 'staging',
      requestedRevision: 'b'.repeat(40),
      repositoryState: async () => ({ revision: SHA, clean: true }),
      commandRunner: async () => ({ code: 0 }),
    }),
    /revision-does-not-match-head/u,
  )
})

test('report path cannot escape the repository', async () => {
  const root = await fixture()
  await assert.rejects(
    runReleaseVerification({
      root,
      profile: 'static',
      reportPath: '../outside.json',
      repositoryState: async () => ({ revision: SHA, clean: true }),
      commandRunner: async () => ({ code: 0 }),
    }),
    /unsafe-report-path/u,
  )
})
