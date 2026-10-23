import { reconcileSolJournal } from './guest-query-evaluation-driver.mjs'
import { prepareSolEvaluation } from './guest-query-evaluation-contract.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimSolWindow, safeSolFailure } from './guest-query-evaluation-driver.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateSolResponse,
  validateLocalGoldReview,
  verifySolExecutionPreflight,
} from './guest-query-evaluation-driver.mjs'

const observed = () => ({
  model: 'gpt-6.1-sol',
  id: 'resp_fictional',
  status: 'completed',
  service_tier: 'default',
  output_text: 'Fictional observed response.',
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 3 },
  },
})

test('only complete exact Sol standard response with fully consistent usage can settle', () => {
  assert.equal(validateSolResponse(observed()).total_tokens, 120)
  for (const failure of [
    'missing-text',
    'model',
    'tier',
    'incomplete',
    'missing-cache-write',
    'fraction',
    'total',
    'reasoning',
    'bounds',
  ]) {
    const row = observed()
    if (failure === 'missing-text') delete row.output_text
    if (failure === 'model') row.model = 'gpt-6-luna'
    if (failure === 'tier') row.service_tier = 'fast'
    if (failure === 'incomplete') row.status = 'incomplete'
    if (failure === 'missing-cache-write') delete row.usage.input_tokens_details.cache_write_tokens
    if (failure === 'fraction') row.usage.input_tokens = 1.5
    if (failure === 'total') row.usage.total_tokens = 1
    if (failure === 'reasoning') row.usage.output_tokens_details.reasoning_tokens = 21
    if (failure === 'bounds') row.usage.input_tokens = 300000
    assert.throws(() => validateSolResponse(row))
  }
})

test('one local Gold result is identity-bound; any required omission or unsupported claim fails', () => {
  const expected = { caseId: 'scope-1', resultSha256: 'a'.repeat(64) }
  const grade = {
    schema: 'torchiko-sol-local-gold-review-v1',
    ...expected,
    pass: true,
    requiredFactsSatisfied: true,
    requiredOmissionsSatisfied: true,
    unsupportedClaims: [],
  }
  validateLocalGoldReview(grade, expected)
  for (const row of [
    { ...grade, pass: false },
    { ...grade, requiredFactsSatisfied: false },
    { ...grade, requiredOmissionsSatisfied: false },
    { ...grade, unsupportedClaims: ['invented reopening'] },
    { ...grade, resultSha256: 'b'.repeat(64) },
  ])
    assert.throws(() => validateLocalGoldReview(row, expected))
})

test('execution has no implicit default budget or environment approval', () => {
  assert.throws(() => verifySolExecutionPreflight({}))
})

test('authorization is permanently bound to one run directory and concurrent owner', () => {
  const claimsRoot = mkdtempSync(join(tmpdir(), 'sol-claims-'))
  const directory = join(claimsRoot, 'approved-run')
  const input = {
    claimsRoot,
    directory,
    authorizationRef: { sha256: 'a'.repeat(64) },
    authorization: { windowId: '123e4567-e89b-42d3-a456-426614174000', runDirectory: directory },
  }
  const owner = claimSolWindow(input)
  assert.throws(() => claimSolWindow(input))
  assert.throws(() => claimSolWindow({ ...input, directory: join(claimsRoot, 'second-run') }))
  assert.throws(() => claimSolWindow({ ...input, authorizationRef: { sha256: 'b'.repeat(64) } }))
  owner.release()
  const next = claimSolWindow(input)
  next.release()
  writeFileSync(join(owner.claimDirectory, 'STOPPED.json'), '{}')
  assert.throws(() => claimSolWindow(input))
})

test('provider failure sanitizer never persists submitted secret or raw provider message', () => {
  const secret = 'SENTINEL_SECRET_MUST_NOT_APPEAR'
  const safe = safeSolFailure({
    message: `Invalid API key ${secret}`,
    status: 401,
    headers: { authorization: secret },
    request_id: secret,
  })
  assert.deepEqual(safe, { category: 'PROVIDER_OR_RUNTIME_FAILED', status: 401 })
  assert.ok(!JSON.stringify(safe).includes(secret))
})

test('mutable state cannot reopen consumed or uncertain append-only reservations', () => {
  const plan = prepareSolEvaluation([
    {
      caseId: 'case-1',
      fixtureId: 'fictional-museum-5',
      fixtureSha256: 'a'.repeat(64),
      question: 'When does Moon Ride close?',
      clock: '2026-10-24T16:30:00.000Z',
      timeZone: 'America/Chicago',
    },
  ])
  const refs = {
    planRef: { sha256: 'plan' },
    sealRef: { sha256: 'seal' },
    authorizationRef: { sha256: 'authorization' },
  }
  const state = {
    ...refs,
    completedCalls: 3,
    completedPairs: 1,
    reservedE8Usd: plan.maximumReservedE8Usd,
    waitingForGold: { resultSha256: 'result' },
  }
  const events = [
    { event: 'OPEN', ...refs },
    ...plan.calls.flatMap((call) => [
      { event: 'DISPATCH_RESERVED', callId: call.id, reserveE8Usd: call.reserveE8Usd },
      { event: 'DISPATCH_STARTED', callId: call.id },
      { event: 'OBSERVED_COMPLETE', callId: call.id },
    ]),
    { event: 'AWAITING_LOCAL_GOLD_REVIEW', result: { sha256: 'result' } },
  ]
  assert.equal(reconcileSolJournal({ plan, state, events }), true)
  for (const changed of [
    { ...state, completedCalls: 0 },
    { ...state, reservedE8Usd: '0' },
    { ...state, completedPairs: 0 },
  ])
    assert.throws(() => reconcileSolJournal({ plan, state: changed, events }))
  assert.throws(() =>
    reconcileSolJournal({
      plan,
      state,
      events: events.filter((row) => row.event !== 'OBSERVED_COMPLETE'),
    }),
  )
  assert.throws(() => reconcileSolJournal({ plan, state, events: [...events, { event: 'STOP' }] }))
})

test('response text matches actual adapter fallback and rejects malformed output shapes', () => {
  const fallback = {
    ...observed(),
    output_text: ' ',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'Valid fallback.' }] }],
  }
  assert.equal(validateSolResponse(fallback).total_tokens, 120)
  const missing = { ...fallback }
  delete missing.output_text
  assert.equal(validateSolResponse(missing).total_tokens, 120)
  assert.throws(() =>
    validateSolResponse({
      ...fallback,
      output: [{ type: 'message', content: [{ type: 'output_text', text: 123 }] }],
    }),
  )
  assert.throws(() =>
    validateSolResponse({
      ...fallback,
      output: [{ type: 'message', content: [{ type: 'output_text', text: ' ' }] }],
    }),
  )
})
