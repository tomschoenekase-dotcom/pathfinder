import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'

import {
  parseHostedVisitorPerformanceArgs,
  resolveHostedVisitorPerformanceReportPath,
  hostedOperationNames,
  summarizeHostedVisitorSamples,
  validateHostedVisitorSamples,
} from '../apps/dashboard/scripts/measure-hosted-visitor-performance.mjs'

const revision = 'a'.repeat(40)

test('requires exact revision, safe venue slug, and bounded samples', () => {
  assert.deepEqual(parseHostedVisitorPerformanceArgs(['--revision', revision]), {
    revision,
    venueSlug: 'riverside-aquarium',
    samples: 10,
    report: null,
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
  assert.deepEqual(
    summarizeHostedVisitorSamples([sample(10), sample(30)]).sendReadyMs,
    { observedCount: 2, median: 20, minimum: 10, maximum: 30 },
  )
  assert.deepEqual(
    summarizeHostedVisitorSamples([sample(10)]).historyRequestDurationMs,
    { observedCount: 0, median: null, minimum: null, maximum: null },
  )
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
