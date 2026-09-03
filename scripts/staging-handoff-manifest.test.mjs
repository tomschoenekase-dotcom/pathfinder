import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildStagingHandoffManifest,
  parseStagingHandoffArgs,
  validateFeatureFlagDefaults,
  validateReleaseReport,
} from './lib/staging-handoff-manifest.mjs'
import { RAILWAY_STATUS_COMMAND } from './lib/railway-cli-contract.mjs'

const BASE = 'a'.repeat(40)
const CANDIDATE = 'b'.repeat(40)
const HASH = 'c'.repeat(64)

function input(overrides = {}) {
  return {
    baseRef: 'origin/codex/pathfinder-v2-staging',
    baseRevision: BASE,
    candidate: CANDIDATE,
    clean: true,
    baseIsAncestor: true,
    ahead: 3,
    behind: 0,
    delta: {
      changedFiles: 5,
      additions: 50,
      deletions: 4,
      pathSetSha256: HASH,
      commitSetSha256: HASH,
      patchSha256: HASH,
    },
    releaseReportPath: 'artifacts/release-verification/candidate.json',
    releaseReportSha256: HASH,
    releaseAssessment: {
      profile: 'candidate',
      readiness: 'ready-for-staging-review',
      passed: 21,
      failed: 0,
      blocked: 0,
    },
    migrations: { count: 159, latest: '20260824010000_example', chainSha256: HASH },
    staging: {
      healthUrl: 'https://staging.example.test/api/health',
      host: 'staging.example.test',
      resources: { database: 'db', redis: 'redis', storage: 'storage' },
    },
    featureFlagEnvironmentVariables: ['SAFE_FEATURE_ENABLED'],
    ...overrides,
  }
}

test('builds a deterministic secret-free owner handoff with retained boundaries', () => {
  const first = buildStagingHandoffManifest(input())
  const second = buildStagingHandoffManifest(input())
  assert.deepEqual(first, second)
  assert.equal(first.admission.status, 'ready-for-owner-staging-integration')
  assert.equal(first.rolloutSafety.featureFlagDefaultsDisabled, true)
  assert.equal(first.rolloutSafety.productionDeploymentAuthorized, false)
  assert.equal(first.rolloutSafety.customerContactAuthorized, false)
  assert.deepEqual(first.rolloutSafety.applicationReleaseIdentity, {
    variable: 'PATHFINDER_RELEASE_SHA',
    value: CANDIDATE,
    services: ['web', 'dashboard', 'workers'],
    mustMatchProviderRelease: true,
  })
  assert.deepEqual(first.rolloutSafety.topologyAdmission, {
    input: RAILWAY_STATUS_COMMAND,
    command: `pnpm verify:staging-topology --expected-revision ${CANDIDATE}`,
    services: ['staging-web', 'staging-dashboard', 'staging-workers'],
    requiresSuccessfulDeployment: true,
    requiresRunningInstance: true,
  })
  assert.deepEqual(first.rolloutSafety.runtimeAudit, {
    deploymentIdentitySource: 'rolloutSafety.topologyAdmission',
    commandTemplate: `pnpm verify:staging-runtime --web-deployment <staging-web-deployment-id> --dashboard-deployment <staging-dashboard-deployment-id> --workers-deployment <staging-workers-deployment-id> --expected-revision ${CANDIDATE} --since 24h`,
    services: ['staging-web', 'staging-dashboard', 'staging-workers'],
    requiresProviderExitSuccess: true,
    rawLogsRetained: false,
  })
  assert.equal(
    first.rolloutSafety.stagingPredeployServiceEnvironment.requiredExactServiceVariables
      .PATHFINDER_STAGING_MIGRATION_APPROVAL,
    'torchiko-staging-lineage-to-207-20260901',
  )
  assert.equal(
    first.rolloutSafety.stagingPredeployServiceEnvironment.requiredExactServiceVariables
      .PATHFINDER_RELEASE_SHA,
    CANDIDATE,
  )
  assert.deepEqual(first.rolloutSafety.stagingPredeployServiceEnvironment.oneRunServiceVariable, {
    name: 'PATHFINDER_ALLOW_STAGING_MIGRATIONS',
    admittedValue: '1',
    closedValue: '0',
  })
  assert.deepEqual(first.rolloutSafety.variableUpdateDeploymentPolicy, {
    suppressAutomaticDeploys: true,
    railwayCliFlag: '--skip-deploys',
    reason: 'Stage every exact rollout prerequisite before creating any deployment.',
  })
  assert.equal(
    first.admission.requiredActions.some(
      (action) =>
        action.includes('PATHFINDER_RELEASE_SHA') && action.includes('web, dashboard, and workers'),
    ),
    true,
  )
  const releaseVariableAction = first.admission.requiredActions.findIndex((action) =>
    action.includes('PATHFINDER_RELEASE_SHA'),
  )
  const deployAction = first.admission.requiredActions.findIndex((action) =>
    action.includes('Deploy the resulting immutable staging revision'),
  )
  const migrationPredeployAction = first.admission.requiredActions.findIndex(
    (action) =>
      action.includes('checked-in staging migration predeploy') &&
      action.includes('before service startup'),
  )
  const migrationOptInAction = first.admission.requiredActions.findIndex((action) =>
    action.includes('PATHFINDER_ALLOW_STAGING_MIGRATIONS=1'),
  )
  const migrationApprovalAction = first.admission.requiredActions.findIndex((action) =>
    action.includes('PATHFINDER_STAGING_MIGRATION_APPROVAL'),
  )
  const migrationCloseAction = first.admission.requiredActions.findIndex((action) =>
    action.includes('PATHFINDER_ALLOW_STAGING_MIGRATIONS=0'),
  )
  assert.ok(releaseVariableAction >= 0)
  assert.ok(migrationOptInAction >= 0)
  assert.ok(migrationApprovalAction >= 0)
  assert.ok(deployAction >= 0)
  assert.equal(migrationPredeployAction, deployAction)
  assert.ok(migrationCloseAction >= 0)
  assert.equal(
    first.admission.requiredActions
      .slice(releaseVariableAction, deployAction)
      .every((action) => action.includes('--skip-deploys')),
    true,
  )
  assert.ok(releaseVariableAction < deployAction)
  assert.ok(migrationOptInAction < deployAction)
  assert.ok(migrationApprovalAction < deployAction)
  assert.ok(deployAction < migrationCloseAction)
  assert.equal(
    first.admission.requiredActions.some(
      (action) => action.includes(RAILWAY_STATUS_COMMAND) && action.includes('three-service'),
    ),
    true,
  )
  assert.equal(
    first.admission.requiredActions.some(
      (action) =>
        action.includes('verify:staging-runtime') &&
        action.includes('exact deployment IDs') &&
        action.includes('refused empty provider query'),
    ),
    true,
  )
  assert.equal(JSON.stringify(first).includes('generatedAt'), false)
})

test('fails closed on dirty, divergent, unchanged, or invalid migration state', () => {
  for (const candidate of [
    { clean: false },
    { baseIsAncestor: false },
    { behind: 1 },
    { ahead: 0 },
    { migrations: { count: 0, latest: undefined, chainSha256: HASH } },
  ]) {
    assert.throws(() => buildStagingHandoffManifest(input(candidate)), /not-admissible|dirty/u)
  }
})

test('admits only an exact clean candidate release assessment', () => {
  const report = {
    schemaVersion: 1,
    revision: CANDIDATE,
    profile: 'candidate',
    readiness: 'ready-for-staging-review',
    repository: { clean: true },
    summary: { passed: 21, failed: 0, blocked: 0 },
  }
  assert.equal(validateReleaseReport(report, CANDIDATE).passed, 21)
  for (const invalid of [
    { ...report, revision: BASE },
    { ...report, profile: 'static' },
    { ...report, readiness: 'not-ready' },
    { ...report, repository: { clean: false } },
    { ...report, summary: { passed: 20, failed: 1, blocked: 0 } },
  ]) {
    assert.throws(() => validateReleaseReport(invalid, CANDIDATE), /not-admissible/u)
  }
})

test('requires every centralized feature switch to remain default-off', () => {
  assert.deepEqual(
    validateFeatureFlagDefaults(`
      one: { environmentVariable: 'ONE_ENABLED', defaultEnabled: false },
      two: { environmentVariable: 'TWO_ENABLED', defaultEnabled: false },
    `),
    ['ONE_ENABLED', 'TWO_ENABLED'],
  )
  assert.throws(
    () =>
      validateFeatureFlagDefaults(
        `one: { environmentVariable: 'ONE_ENABLED', defaultEnabled: true }`,
      ),
    /default-enabled/u,
  )
  assert.throws(() => validateFeatureFlagDefaults('export const none = {}'), /not-found/u)
})

test('parses bounded options and requires the candidate report', () => {
  assert.deepEqual(parseStagingHandoffArgs(['--release-report', 'candidate.json']), {
    baseRef: 'origin/codex/pathfinder-v2-staging',
    candidate: undefined,
    releaseReport: 'candidate.json',
    report: undefined,
  })
  assert.throws(() => parseStagingHandoffArgs([]), /release-report-required/u)
  assert.throws(
    () => parseStagingHandoffArgs(['--release-report', 'a.json', '--release-report', 'b.json']),
    /duplicate-option/u,
  )
  assert.throws(() => parseStagingHandoffArgs(['--unsafe', 'x']), /unknown-option/u)
})
