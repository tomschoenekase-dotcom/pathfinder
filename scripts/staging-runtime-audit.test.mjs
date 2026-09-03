import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { RAILWAY_CLI_PACKAGE, RAILWAY_STATUS_COMMAND } from './lib/railway-cli-contract.mjs'

import {
  auditStagingRuntime,
  buildRuntimeLogQueries,
  parseBoundedLogLines,
  parseStagingRuntimeArgs,
} from './lib/staging-runtime-audit.mjs'

const IDS = {
  'staging-web': '11111111-1111-4111-8111-111111111111',
  'staging-dashboard': '22222222-2222-4222-8222-222222222222',
  'staging-workers': '33333333-3333-4333-8333-333333333333',
}
const SHA = 'a'.repeat(40)
const SNAPSHOT_SHA = 'c'.repeat(40)

const ARGS = [
  '--web-deployment',
  IDS['staging-web'],
  '--dashboard-deployment',
  IDS['staging-dashboard'],
  '--workers-deployment',
  IDS['staging-workers'],
  '--expected-revision',
  SHA,
  '--since',
  '24h',
]

test('requires exact service deployment identities, release identity, and a bounded 24-hour window', () => {
  assert.deepEqual(parseStagingRuntimeArgs(ARGS), {
    deployments: IDS,
    expectedRevision: SHA,
    since: '24h',
  })
  for (const args of [ARGS.slice(0, -1), [...ARGS.slice(0, -1), '7d'], ['--help']]) {
    assert.throws(() => parseStagingRuntimeArgs(args), /invalid-options/u)
  }
})

test('binds every Railway query to both the exact deployment and exact staging service', () => {
  const queries = buildRuntimeLogQueries({ deployments: IDS, since: '24h' })
  assert.equal(queries.length, 6)
  for (const query of queries) {
    assert.equal(query.args[1], IDS[query.service])
    assert.deepEqual(query.args.slice(2, 6), [
      '--service',
      query.service,
      '--environment',
      'staging',
    ])
    assert.ok(query.args.includes('--lines'))
    assert.ok(query.args.includes('--json'))
  }
})

test('admits successful empty error and 5xx queries while reporting bounded worker continuity', () => {
  const workerRows = [
    { action: 'workers.release-identity.admitted', revision: SHA },
    {
      action: 'workers.founder-absence-observation.retained',
      observedOn: '2026-08-31',
      evidenceComplete: true,
      releaseSha: SNAPSHOT_SHA,
    },
  ]
  let call = 0
  const result = auditStagingRuntime(
    { deployments: IDS, expectedRevision: SHA, since: '24h' },
    () => {
      call += 1
      return {
        status: 0,
        stdout: call === 6 ? `${workerRows.map(JSON.stringify).join('\n')}\n` : '',
      }
    },
  )
  assert.equal(result.ok, true)
  assert.equal(result.services['staging-web'].http5xxRows, 0)
  assert.deepEqual(result.founderAbsence, {
    retainedEvents: 1,
    failedEvents: 0,
    latestObservedOn: '2026-08-31',
    latestEvidenceComplete: true,
    latestSnapshotReleaseSha: SNAPSHOT_SHA,
  })
  assert.equal(result.expectedRevision, SHA)
})

test('fails closed when worker runtime identity is missing, malformed, or differs from the release', () => {
  for (const admission of [
    null,
    { action: 'workers.release-identity.admitted' },
    { action: 'workers.release-identity.admitted', revision: 'b'.repeat(40) },
  ]) {
    let call = 0
    assert.throws(() =>
      auditStagingRuntime({ deployments: IDS, expectedRevision: SHA, since: '24h' }, () => {
        call += 1
        const rows = [
          ...(admission ? [admission] : []),
          {
            action: 'workers.founder-absence-observation.retained',
            observedOn: '2026-08-31',
            evidenceComplete: true,
            releaseSha: SHA,
          },
        ]
        return {
          status: 0,
          stdout: call === 6 ? `${rows.map(JSON.stringify).join('\n')}\n` : '',
        }
      }),
    )
  }
})

test('fails closed when founder-absence evidence is missing or malformed', () => {
  for (const row of [
    null,
    {
      action: 'workers.founder-absence-observation.retained',
      observedOn: '2026-08-31',
      evidenceComplete: true,
    },
    {
      action: 'workers.founder-absence-observation.retained',
      observedOn: '2026-08-31',
      evidenceComplete: true,
      releaseSha: 'invalid',
    },
  ]) {
    let call = 0
    assert.throws(() =>
      auditStagingRuntime({ deployments: IDS, expectedRevision: SHA, since: '24h' }, () => {
        call += 1
        return {
          status: 0,
          stdout:
            call === 6
              ? `${[
                  { action: 'workers.release-identity.admitted', revision: SHA },
                  ...(row ? [row] : []),
                ]
                  .map(JSON.stringify)
                  .join('\n')}\n`
              : '',
        }
      }),
    )
  }
})

test('fails closed on provider refusal, malformed or oversized output, and runtime failures', () => {
  assert.throws(
    () =>
      auditStagingRuntime({ deployments: IDS, expectedRevision: SHA, since: '24h' }, () => ({
        status: 1,
        stdout: '',
      })),
    /railway-query-failed/u,
  )
  assert.throws(() => parseBoundedLogLines('{private malformed detail'), /invalid-log-json/u)
  assert.throws(() => parseBoundedLogLines('x'.repeat(1_048_577)), /invalid-log-output/u)

  for (const row of [
    { level: 'error', message: 'private detail' },
    { action: 'workers.founder-absence-observation.failed', message: 'private detail' },
  ]) {
    let call = 0
    assert.throws(() =>
      auditStagingRuntime({ deployments: IDS, expectedRevision: SHA, since: '24h' }, () => {
        call += 1
        const target = row.level === 'error' ? 1 : 6
        return { status: 0, stdout: call === target ? `${JSON.stringify(row)}\n` : '' }
      }),
    )
  }
})

test('CLI contains option and provider failures without echoing private content', () => {
  const invalid = spawnSync(process.execPath, ['scripts/verify-staging-runtime.mjs', '--help'], {
    encoding: 'utf8',
  })
  assert.equal(invalid.status, 1)
  assert.equal(invalid.stdout, '')
  assert.equal(invalid.stderr, 'Staging runtime audit failed: invalid-options\n')
})

test('Windows reaches the npm shim through Node without a command shell', () => {
  const source = readFileSync('scripts/verify-staging-runtime.mjs', 'utf8')
  assert.match(source, /process\.execPath/u)
  assert.match(source, /node_modules\/npm\/bin\/npx-cli\.js/u)
  assert.match(source, /shell: false/u)
  assert.doesNotMatch(source, /ComSpec|cmd\.exe|shell: true/u)
})

test('Railway provider reads use one exact CLI package identity', () => {
  assert.match(RAILWAY_CLI_PACKAGE, /^@railway\/cli@\d+\.\d+\.\d+$/u)
  assert.equal(RAILWAY_STATUS_COMMAND, `npx --yes ${RAILWAY_CLI_PACKAGE} status --json`)
  const runtimeSource = readFileSync('scripts/verify-staging-runtime.mjs', 'utf8')
  const handoffSource = readFileSync('scripts/lib/staging-handoff-manifest.mjs', 'utf8')
  assert.match(runtimeSource, /RAILWAY_CLI_PACKAGE/u)
  assert.match(handoffSource, /RAILWAY_STATUS_COMMAND/u)
  assert.doesNotMatch(`${runtimeSource}\n${handoffSource}`, /['"]@railway\/cli['"]/u)
})
