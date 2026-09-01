import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'

import {
  parseHostedDashboardAssetArgs,
  resolveHostedDashboardAssetReportPath,
  summarizeDashboardAssetSamples,
  validateDashboardAssetPolicy,
} from '../apps/dashboard/scripts/measure-hosted-dashboard-assets.mjs'

const revision = 'a'.repeat(40)

test('requires an exact revision and bounded sample count', () => {
  assert.deepEqual(parseHostedDashboardAssetArgs(['--revision', revision]), {
    revision,
    samples: 3,
    report: null,
  })
  assert.equal(parseHostedDashboardAssetArgs(['--revision', revision, '--samples', '5']).samples, 5)
  assert.throws(() => parseHostedDashboardAssetArgs(['--revision', 'short']), /exact-revision/u)
  assert.throws(
    () => parseHostedDashboardAssetArgs(['--revision', revision, '--samples', '6']),
    /samples-out-of-range/u,
  )
})

test('accepts only the exact credential-free HTTPS dashboard origin', () => {
  assert.equal(
    validateDashboardAssetPolicy({
      dashboardUrl: 'https://dashboard.example.test/',
      dashboardHost: 'dashboard.example.test',
    }),
    'https://dashboard.example.test',
  )
  assert.throws(
    () =>
      validateDashboardAssetPolicy({
        dashboardUrl: 'https://user:secret@dashboard.example.test/',
        dashboardHost: 'dashboard.example.test',
      }),
    /policy-origin-invalid/u,
  )
})

test('keeps reports inside the repository and summarizes nearest-rank distributions', () => {
  const report = resolveHostedDashboardAssetReportPath(null, revision)
  assert.equal(path.basename(report), `${revision}.json`)
  assert.throws(
    () => resolveHostedDashboardAssetReportPath('../outside.json', revision),
    /unsafe-report-path/u,
  )
  const summary = summarizeDashboardAssetSamples([
    {
      domContentLoadedMs: 10,
      loadEventMs: 20,
      sameOriginRequests: 3,
      sameOriginTransferBytes: 100,
      scriptRequests: 2,
      scriptTransferBytes: 80,
    },
    {
      domContentLoadedMs: 30,
      loadEventMs: 40,
      sameOriginRequests: 5,
      sameOriginTransferBytes: 300,
      scriptRequests: 4,
      scriptTransferBytes: 240,
    },
    {
      domContentLoadedMs: 20,
      loadEventMs: 30,
      sameOriginRequests: 4,
      sameOriginTransferBytes: 200,
      scriptRequests: 3,
      scriptTransferBytes: 160,
    },
  ])
  assert.deepEqual(summary.scriptTransferBytes, {
    minimum: 80,
    p50: 160,
    p95: 240,
    maximum: 240,
  })
})
