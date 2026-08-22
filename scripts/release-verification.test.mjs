import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildReleaseGates,
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
  assert.ok(candidateIds.includes('test'))
  assert.ok(candidateIds.includes('build'))
  assert.ok(candidateIds.includes('accessibility'))
})

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
