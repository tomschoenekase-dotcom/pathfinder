import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'

import {
  parseHostedVisitorPerformanceArgs,
  resolveHostedVisitorPerformanceReportPath,
  summarizeHostedVisitorSamples,
  validateHostedVisitorSamples,
} from '../apps/dashboard/scripts/measure-hosted-visitor-performance.mjs'

const revision = 'a'.repeat(40)

test('requires exact revision, safe venue slug, and bounded samples', () => {
  assert.deepEqual(parseHostedVisitorPerformanceArgs(['--revision', revision]), {
    revision,
    venueSlug: 'riverside-aquarium',
    samples: 3,
    report: null,
  })
  assert.throws(() => parseHostedVisitorPerformanceArgs(['--revision', 'short']), /exact-revision/u)
  assert.throws(
    () => parseHostedVisitorPerformanceArgs(['--revision', revision, '--venue-slug', '../admin']),
    /unsafe-venue-slug/u,
  )
  assert.throws(
    () => parseHostedVisitorPerformanceArgs(['--revision', revision, '--samples', '6']),
    /samples-out-of-range/u,
  )
})

test('keeps reports inside the repository and summarizes distributions', () => {
  assert.equal(
    path.basename(resolveHostedVisitorPerformanceReportPath(null, revision)),
    `${revision}.json`,
  )
  assert.throws(
    () => resolveHostedVisitorPerformanceReportPath('../outside.json', revision),
    /unsafe-report-path/u,
  )
  const sample = (interactionReadyMs) => ({
    interactionReadyMs,
    domContentLoadedMs: interactionReadyMs - 2,
    loadEventMs: interactionReadyMs - 1,
    resourceTransferBytes: interactionReadyMs * 10,
    scriptTransferBytes: interactionReadyMs * 5,
    longestLongTaskMs: interactionReadyMs,
  })
  assert.deepEqual(
    summarizeHostedVisitorSamples([sample(10), sample(30), sample(20)]).interactionReadyMs,
    {
      minimum: 10,
      p50: 20,
      p95: 30,
      maximum: 30,
    },
  )
})

test('rejects missing, redirected, errored, or transfer-free evidence', () => {
  const valid = {
    finalPath: '/riverside-aquarium/chat',
    browserErrors: [],
    interactionReadyMs: 1,
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
})
