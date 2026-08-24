import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MAX_SYNTHETIC_RESPONSE_BYTES,
  assessSyntheticConversationResponse,
} from './lib/synthetic-conversation-assessment.mjs'
import {
  buildConversationAssessment,
  buildConversationReplay,
} from './lib/torchiko-developer-tools.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('all canonical scenario answers can pass with fixture-owned evidence', async () => {
  const cases = [
    ['small-museum', 'The Harbor Gallery is the place to visit.'],
    ['outdoor-park', 'Begin at the South Trailhead.'],
    ['attraction', 'The Observation Wheel is open during the posted hours.'],
    ['large-museum', 'The Family Lab is a good family activity.'],
  ]
  for (const [scenarioId, response] of cases) {
    const report = await buildConversationAssessment(root, scenarioId, response)
    assert.equal(report.verdict, 'pass')
    assert.equal(report.summary.missing, 0)
    assert.equal(report.providerDispatch, false)
    assert.equal(report.grounding.unsupportedClaimsEvaluated, false)
    assert.ok(report.assertions.every((assertion) => assertion.evidence.length > 0))
  }
})

test('missing required facts fail closed with an explicit explanation', async () => {
  const report = await buildConversationAssessment(
    root,
    'attraction',
    'The Observation Wheel is near the water.',
  )
  assert.equal(report.verdict, 'fail')
  assert.deepEqual(report.summary, { required: 2, matched: 1, missing: 1 })
  assert.equal(report.assertions.find((item) => item.id === 'venue-operating-hours').matched, false)
  assert.match(
    report.assertions.find((item) => item.id === 'venue-operating-hours').explanation,
    /does not contain/iu,
  )
})

test('matching is case and punctuation tolerant but respects token boundaries', async () => {
  const replay = await buildConversationReplay(root, 'large-museum')
  assert.equal(assessSyntheticConversationResponse(replay, 'Try the FAMILY—LAB!').verdict, 'pass')
  assert.equal(
    assessSyntheticConversationResponse(replay, 'This is family laboratory time.').verdict,
    'fail',
  )
})

test('reports retain only response hash and byte length', async () => {
  const secretMarker = 'Family Lab SECRET_RESPONSE_MARKER'
  const report = await buildConversationAssessment(root, 'large-museum', secretMarker)
  assert.equal(report.response.retained, false)
  assert.equal(report.response.bytes, Buffer.byteLength(secretMarker))
  assert.equal(report.response.sha256.length, 64)
  assert.doesNotMatch(JSON.stringify(report), /SECRET_RESPONSE_MARKER/u)
})

test('empty and oversized responses are rejected before assessment', async () => {
  const replay = await buildConversationReplay(root, 'large-museum')
  assert.throws(() => assessSyntheticConversationResponse(replay, '  '), /response-required/u)
  assert.throws(
    () => assessSyntheticConversationResponse(replay, 'x'.repeat(MAX_SYNTHETIC_RESPONSE_BYTES + 1)),
    /response-too-large/u,
  )
})

test('CLI accepts bounded stdin and uses exit status as a quality gate', () => {
  const pass = spawnSync(
    process.execPath,
    ['scripts/torchiko.mjs', 'replay', 'assess', 'large-museum', '--stdin', '--json'],
    { cwd: root, input: 'Visit the Family Lab.', encoding: 'utf8' },
  )
  assert.equal(pass.status, 0, pass.stderr)
  assert.equal(JSON.parse(pass.stdout).verdict, 'pass')

  const fail = spawnSync(
    process.execPath,
    ['scripts/torchiko.mjs', 'replay', 'assess', 'large-museum', '--stdin', '--json'],
    { cwd: root, input: 'Try the cafe.', encoding: 'utf8' },
  )
  assert.equal(fail.status, 1, fail.stderr)
  assert.equal(JSON.parse(fail.stdout).verdict, 'fail')
})
