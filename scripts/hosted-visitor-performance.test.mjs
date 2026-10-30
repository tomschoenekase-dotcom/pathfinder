import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'

import {
  parseHostedVisitorPerformanceArgs,
  resolveHostedVisitorPerformanceReportPath,
  hostedOperationNames,
  summarizeHostedVisitorSamples,
  validateHostedVisitorSamples,
  validateHostedTurnQuestions,
  isHostedChatTurnRequest,
  hostedTurnQuestion,
  parseHostedTurnResponse,
  summarizeHostedTurns,
  validateServingRouteObservation,
} from '../apps/dashboard/scripts/measure-hosted-visitor-performance.mjs'

const revision = 'a'.repeat(40)

test('requires exact revision, safe venue slug, and bounded samples', () => {
  assert.deepEqual(parseHostedVisitorPerformanceArgs(['--revision', revision]), {
    revision,
    venueSlug: 'riverside-aquarium',
    samples: 10,
    report: null,
    sendTurns: 0,
    questions: null,
    servingRouteObservation: null,
  })
  assert.throws(() => parseHostedVisitorPerformanceArgs(['--revision', 'short']), /exact-revision/u)
  assert.throws(
    () => parseHostedVisitorPerformanceArgs(['--revision', revision, '--venue-slug', '../admin']),
    /unsafe-venue-slug/u,
  )
  assert.throws(
    () => parseHostedVisitorPerformanceArgs(['--revision', revision, '--samples', '0']),
    /samples-out-of-range/u,
  )
  assert.throws(
    () => parseHostedVisitorPerformanceArgs(['--revision', revision, '--samples', '11']),
    /samples-out-of-range/u,
  )
  assert.throws(
    () => parseHostedVisitorPerformanceArgs(['--revision', revision, '--samples', '2runs']),
    /samples-out-of-range/u,
  )
})

test('keeps reports inside the repository and summarizes medians and observed ranges', () => {
  assert.equal(
    path.basename(resolveHostedVisitorPerformanceReportPath(null, revision)),
    `${revision}.json`,
  )
  assert.throws(
    () => resolveHostedVisitorPerformanceReportPath('../outside.json', revision),
    /unsafe-report-path/u,
  )
  const sample = (interactionReadyMs) => ({
    sendReadyMs: interactionReadyMs,
    documentResponseMs: interactionReadyMs - 4,
    historyRequestDurationMs: null,
    domContentLoadedMs: interactionReadyMs - 2,
    loadEventMs: interactionReadyMs - 1,
    resourceTransferBytes: interactionReadyMs * 10,
    scriptTransferBytes: interactionReadyMs * 5,
    longestLongTaskMs: interactionReadyMs,
  })
  assert.deepEqual(
    summarizeHostedVisitorSamples([sample(10), sample(30), sample(20)]).sendReadyMs,
    {
      observedCount: 3,
      median: 20,
      minimum: 10,
      maximum: 30,
    },
  )
  assert.deepEqual(summarizeHostedVisitorSamples([sample(10), sample(30)]).sendReadyMs, {
    observedCount: 2,
    median: 20,
    minimum: 10,
    maximum: 30,
  })
  assert.deepEqual(summarizeHostedVisitorSamples([sample(10)]).historyRequestDurationMs, {
    observedCount: 0,
    median: null,
    minimum: null,
    maximum: null,
  })
})

test('recognizes only safe history/session operation names from tRPC request paths', () => {
  assert.deepEqual(
    hostedOperationNames('https://stage.example/api/trpc/chat.history,chat.session?batch=1'),
    ['chat.history', 'chat.session'],
  )
  assert.deepEqual(hostedOperationNames('https://stage.example/api/trpc/chat-stream'), [])
  assert.deepEqual(hostedOperationNames('not a URL'), [])
})

test('rejects missing, redirected, errored, or transfer-free evidence', () => {
  const valid = {
    finalPath: '/riverside-aquarium/chat',
    browserErrors: [],
    status: 'passed',
    sendReadyMs: 1,
    resourceRequests: 1,
    resourceTransferBytes: 1,
    scriptRequests: 1,
    scriptTransferBytes: 1,
  }
  assert.doesNotThrow(() => validateHostedVisitorSamples([valid], valid.finalPath))
  assert.throws(() => validateHostedVisitorSamples([], valid.finalPath), /samples-missing/u)
  assert.throws(
    () => validateHostedVisitorSamples([{ ...valid, finalPath: '/sign-in' }], valid.finalPath),
    /route-mismatch/u,
  )
  assert.throws(
    () => validateHostedVisitorSamples([{ ...valid, browserErrors: [{}] }], valid.finalPath),
    /browser-errors/u,
  )
  assert.throws(
    () => validateHostedVisitorSamples([{ ...valid, scriptTransferBytes: 0 }], valid.finalPath),
    /transfer-evidence-missing/u,
  )
  assert.throws(
    () => validateHostedVisitorSamples([{ ...valid, status: 'failed' }], valid.finalPath),
    /sample-failed/u,
  )
  assert.throws(
    () => validateHostedVisitorSamples([{ ...valid, browserErrors: [{}] }], valid.finalPath),
    /browser-errors/u,
  )
})

test('send turns are opt-in, bounded globally to five and require explicit fresh questions', () => {
  for (const value of ['-1', '6', 'NaN', '1.5', '2turns'])
    assert.throws(
      () => parseHostedVisitorPerformanceArgs(['--revision', revision, '--send-turns', value]),
      /send-turns-out-of-range/,
    )
  assert.throws(
    () => parseHostedVisitorPerformanceArgs(['--revision', revision, '--send-turns', '1']),
    /questions-required/,
  )
  const options = parseHostedVisitorPerformanceArgs([
    '--revision',
    revision,
    '--samples',
    '10',
    '--send-turns',
    '5',
    '--questions',
    'fresh-turns.json',
  ])
  assert.equal(options.sendTurns, 5)
  assert.equal(options.samples, 10)
  assert.deepEqual(validateHostedTurnQuestions([' First? ', 'Second?'], 1), ['First?'])
  for (const value of [null, {}, [''], ['x'.repeat(1001)], [{ question: 'No inferred schema' }]])
    assert.throws(() => validateHostedTurnQuestions(value, 1), /invalid-turn-questions/)
  assert.throws(() => validateHostedTurnQuestions(['Only one?'], 2), /invalid-turn-questions/)
  assert.throws(
    () => validateHostedTurnQuestions(Array(6).fill('Question?'), 6),
    /send-turns-out-of-range/,
  )
})
test('turn matching binds exact POST origin, transport operation and question without retaining tokens', () => {
  const origin = 'http://127.0.0.1:4444'
  assert.equal(isHostedChatTurnRequest(origin + '/api/chat-stream', 'POST', origin), true)
  for (const [url, method] of [
    [origin + '/api/chat-stream', 'GET'],
    ['http://other.invalid/api/chat-stream', 'POST'],
    [origin + '/api/trpc/chat.sender', 'POST'],
    [origin + '/api/trpc/chat.history', 'POST'],
  ])
    assert.equal(isHostedChatTurnRequest(url, method, origin), false)
  assert.equal(
    hostedTurnQuestion(
      origin + '/api/chat-stream',
      JSON.stringify({ message: 'Fresh question?', anonymousToken: 'not-retained' }),
    ),
    'Fresh question?',
  )
  assert.equal(
    hostedTurnQuestion(
      origin + '/api/trpc/chat.send',
      JSON.stringify({ json: { message: 'Fresh question?' } }),
    ),
    'Fresh question?',
  )
  assert.equal(
    hostedTurnQuestion(
      origin + '/api/trpc/chat.history,chat.send',
      JSON.stringify({ 0: { json: {} }, 1: { json: { message: 'Batched?' } } }),
    ),
    'Batched?',
  )
  assert.equal(hostedTurnQuestion(origin + '/api/chat-stream', 'broken'), null)
})
test('completion requires a complete event, rejects malformed/oversize replies and captures explicit rejection', () => {
  assert.equal(
    parseHostedTurnResponse(
      '{"type":"delta","delta":"Hi"}\n{"type":"complete","result":{"response":"Hello."}}',
    ).completed,
    true,
  )
  assert.throws(
    () => parseHostedTurnResponse('{"type":"delta","delta":"Hi"}'),
    /completion-unconfirmed/,
  )
  assert.throws(() => parseHostedTurnResponse('invalid'))
  assert.throws(() => parseHostedTurnResponse('x'.repeat(1024 * 1024 + 1)), /too-large/)
  assert.equal(
    parseHostedTurnResponse('{"type":"error","publicCode":"REJECTED"}').refusalCode,
    'REJECTED',
  )
  assert.equal(
    parseHostedTurnResponse('{"type":"complete","result":{"response":""}}').completed,
    false,
  )
  assert.equal(
    parseHostedTurnResponse(
      '{"result":{"data":{"json":{"response":"Fallback transport."}}}}',
      false,
    ).completed,
    true,
  )
})
test('failed or missing turn measurements cannot enter timing summaries', () => {
  const summary = summarizeHostedTurns([
    { status: 'passed', firstVisibleAnswerMs: 20, completionMs: 50 },
    { status: 'passed', firstVisibleAnswerMs: 40, completionMs: 100 },
    { status: 'failed', firstVisibleAnswerMs: 1, completionMs: 2 },
  ])
  assert.equal(summary.attempted, 3)
  assert.equal(summary.failed, 1)
  assert.equal(summary.firstVisibleAnswerMs.median, 30)
  assert.equal(summary.completionMs.observedCount, 2)
  assert.equal(summarizeHostedTurns([]).completionMs.median, null)
})
test('supplied route evidence must bind exact revision, venue, observation time and route shape', () => {
  const options = { revision, venueSlug: 'fictional-garden' }
  const observation = {
    revision,
    deployedRevision: revision,
    venueSlug: 'fictional-garden',
    observedAt: '2026-10-01T12:00:00Z',
    guideStrategy: 'full',
    modelKey: 'test-model',
    venueScopeExceptions: [],
  }
  assert.deepEqual(validateServingRouteObservation(observation, options), observation)
  for (const patch of [
    { revision: 'b'.repeat(40) },
    { deployedRevision: 'b'.repeat(40) },
    { venueSlug: 'other' },
    { observedAt: 'invalid' },
    { observedAt: '2099-01-01T00:00:00Z' },
    { modelKey: '' },
    { guideStrategy: '' },
    { venueScopeExceptions: null },
  ])
    assert.throws(
      () => validateServingRouteObservation({ ...observation, ...patch }, options),
      /invalid-serving/,
    )
})

test('multi-chat tRPC batches cannot smuggle multiple turns through one admission', () => {
  assert.equal(
    hostedTurnQuestion(
      'http://localhost/api/trpc/chat.send,chat.stream',
      JSON.stringify({ 0: { json: { message: 'One?' } }, 1: { json: { message: 'Two?' } } }),
    ),
    null,
  )
})
