import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  auditFounderAbsenceHistory,
  buildFounderAbsenceHistoryQueries,
  parseFounderAbsenceHistoryArgs,
} from './lib/founder-absence-history-audit.mjs'

const FIRST = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const SHA = 'a'.repeat(40)

function row(observedOn, evidenceComplete = true, releaseSha = SHA) {
  return {
    action: 'workers.founder-absence-observation.retained',
    observedOn,
    evidenceComplete,
    releaseSha,
  }
}

test('accepts one to eight unique deployment IDs and an exact bounded window', () => {
  const args = [
    '--deployment',
    FIRST,
    '--deployment',
    SECOND,
    '--expected-revision',
    SHA,
    '--since',
    '168h',
  ]
  assert.deepEqual(parseFounderAbsenceHistoryArgs(args), {
    deployments: [FIRST, SECOND],
    expectedRevision: SHA,
    since: '168h',
  })
  for (const invalid of [
    ['--since', '168h'],
    ['--deployment', FIRST, '--expected-revision', SHA, '--since', '7d'],
    ['--deployment', FIRST, '--deployment', FIRST, '--expected-revision', SHA, '--since', '24h'],
    ['--deployment', 'not-a-uuid', '--expected-revision', SHA, '--since', '24h'],
    ['--deployment', FIRST, '--expected-revision', 'short', '--since', '24h'],
  ]) {
    assert.throws(() => parseFounderAbsenceHistoryArgs(invalid), /invalid-options/u)
  }
})

test('binds every query to the exact deployment and staging worker service', () => {
  const queries = buildFounderAbsenceHistoryQueries({
    deployments: [FIRST, SECOND],
    expectedRevision: SHA,
    since: '120h',
  })
  assert.equal(queries.length, 2)
  assert.deepEqual(
    queries.map((query) => query.args[1]),
    [FIRST, SECOND],
  )
  for (const query of queries) {
    assert.deepEqual(query.args.slice(2, 6), [
      '--service',
      'staging-workers',
      '--environment',
      'staging',
    ])
    assert.ok(query.args.includes('--json'))
    assert.ok(query.args.includes('1000'))
  }
})

test('deduplicates immutable daily identity and reports the latest complete streak without authority', () => {
  const batches = [
    [row('2026-08-28'), row('2026-08-29'), row('2026-08-29')],
    [row('2026-08-30'), row('2026-08-31')],
  ]
  let call = 0
  const result = auditFounderAbsenceHistory(
    { deployments: [FIRST, SECOND], expectedRevision: SHA, since: '168h' },
    () => ({ status: 0, stdout: batches[call++].map(JSON.stringify).join('\n') }),
  )
  assert.equal(result.retainedEvents, 5)
  assert.equal(result.observedDays.length, 4)
  assert.equal(result.observedDays[1].events, 2)
  assert.equal(result.streakReleaseSha, SHA)
  assert.equal(result.streakMatchesExpectedRevision, true)
  assert.equal(result.consecutiveCompleteDays, 4)
  assert.equal(result.sevenDayReviewReady, false)
  assert.equal(result.certificationGranted, false)
  assert.equal(result.launchGate, false)
})

test('stops a streak at an incomplete or missing day', () => {
  for (const rows of [
    [row('2026-08-28'), row('2026-08-29', false), row('2026-08-30')],
    [row('2026-08-28'), row('2026-08-30')],
  ]) {
    const result = auditFounderAbsenceHistory(
      { deployments: [FIRST], expectedRevision: SHA, since: '72h' },
      () => ({
        status: 0,
        stdout: rows.map(JSON.stringify).join('\n'),
      }),
    )
    assert.equal(result.consecutiveCompleteDays, 1)
  }
})

test('counts only consecutive complete days for the latest exact release identity', () => {
  const previousSha = 'b'.repeat(40)
  const result = auditFounderAbsenceHistory(
    { deployments: [FIRST], expectedRevision: SHA, since: '96h' },
    () => ({
      status: 0,
      stdout: [
        row('2026-08-28', true, previousSha),
        row('2026-08-29', true, previousSha),
        row('2026-08-30'),
        row('2026-08-31'),
      ]
        .map(JSON.stringify)
        .join('\n'),
    }),
  )

  assert.equal(result.streakReleaseSha, SHA)
  assert.equal(result.consecutiveCompleteDays, 2)
  assert.equal(result.sevenDayReviewReady, false)
})

test('never marks an old release streak review-ready for a different expected revision', () => {
  const oldSha = 'b'.repeat(40)
  const rows = Array.from({ length: 7 }, (_, index) =>
    row(`2026-08-${String(25 + index).padStart(2, '0')}`, true, oldSha),
  )
  const result = auditFounderAbsenceHistory(
    { deployments: [FIRST], expectedRevision: SHA, since: '168h' },
    () => ({ status: 0, stdout: rows.map(JSON.stringify).join('\n') }),
  )
  assert.equal(result.consecutiveCompleteDays, 7)
  assert.equal(result.streakReleaseSha, oldSha)
  assert.equal(result.streakMatchesExpectedRevision, false)
  assert.equal(result.sevenDayReviewReady, false)
})

test('fails closed on provider errors, failed captures, malformed rows, and identity drift', () => {
  const options = { deployments: [FIRST], expectedRevision: SHA, since: '24h' }
  assert.throws(
    () => auditFounderAbsenceHistory(options, () => ({ status: 1, stdout: '' })),
    /railway-query-failed/u,
  )
  assert.throws(
    () =>
      auditFounderAbsenceHistory(options, () => ({
        status: 0,
        stdout: JSON.stringify({ action: 'workers.founder-absence-observation.failed' }),
      })),
    /founder-absence-capture-failed/u,
  )
  assert.throws(
    () =>
      auditFounderAbsenceHistory(options, () => ({
        status: 0,
        stdout: JSON.stringify({ ...row('2026-08-31'), releaseSha: 'private detail' }),
      })),
    /invalid-observation-row/u,
  )
  assert.throws(
    () =>
      auditFounderAbsenceHistory(options, () => ({
        status: 0,
        stdout: [row('2026-08-31'), { ...row('2026-08-31'), releaseSha: 'b'.repeat(40) }]
          .map(JSON.stringify)
          .join('\n'),
      })),
    /observation-identity-drift/u,
  )
})

test('fails closed when Railway output exceeds the local row or byte ceiling', () => {
  const options = { deployments: [FIRST], expectedRevision: SHA, since: '168h' }
  assert.throws(
    () =>
      auditFounderAbsenceHistory(options, () => ({
        status: 0,
        stdout: Array.from({ length: 1001 }, () => JSON.stringify({ action: 'unrelated' })).join(
          '\n',
        ),
      })),
    /invalid-log-output/u,
  )
  assert.throws(
    () =>
      auditFounderAbsenceHistory(options, () => ({
        status: 0,
        stdout: JSON.stringify({ action: 'unrelated', detail: 'x'.repeat(1_048_576) }),
      })),
    /invalid-log-output/u,
  )
})

test('CLI failures expose only a code and Windows uses no command shell', () => {
  const invalid = spawnSync(
    process.execPath,
    ['scripts/verify-founder-absence-history.mjs', '--help'],
    {
      encoding: 'utf8',
    },
  )
  assert.equal(invalid.status, 1)
  assert.equal(invalid.stdout, '')
  assert.equal(invalid.stderr, 'Founder absence history audit failed: invalid-options\n')

  const source = readFileSync('scripts/verify-founder-absence-history.mjs', 'utf8')
  assert.match(source, /RAILWAY_CLI_PACKAGE/u)
  assert.match(source, /process\.execPath/u)
  assert.match(source, /node_modules\/npm\/bin\/npx-cli\.js/u)
  assert.match(source, /shell: false/u)
  assert.doesNotMatch(source, /ComSpec|cmd\.exe|shell: true/u)
})
