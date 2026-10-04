import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertProductionMigrationTarget,
  runProductionMigration,
  PRODUCTION_DATABASE,
  PRODUCTION_ENVIRONMENT,
  PRODUCTION_PROJECT,
} from './lib/production-migration-admission.mjs'
import { EXPECTED } from './run-staging-migration-predeploy.mjs'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const MANIFEST_HASH = EXPECTED.manifestHash
const STARTED_AT = Date.parse('2026-10-03T12:00:00.000Z')

function target(overrides = {}) {
  return {
    RAILWAY_PROJECT_ID: PRODUCTION_PROJECT,
    RAILWAY_ENVIRONMENT_ID: PRODUCTION_ENVIRONMENT,
    RAILWAY_ENVIRONMENT: 'production',
    DATABASE_URL: `postgresql://postgres@db.${PRODUCTION_DATABASE}.supabase.co:5432/postgres`,
    DIRECT_DATABASE_URL: `postgresql://postgres.${PRODUCTION_DATABASE}@region.pooler.supabase.com:5432/postgres`,
    ...overrides,
  }
}

function before(overrides = {}) {
  return {
    schema: 'torchiko-release267-preservation/v2',
    hashVersion: 2,
    target: 'production',
    production: true,
    phase: 'before',
    releaseSha: SHA,
    manifestHash: MANIFEST_HASH,
    project: PRODUCTION_PROJECT,
    environmentId: PRODUCTION_ENVIRONMENT,
    databaseResource: PRODUCTION_DATABASE,
    activeLedgerCount: 255,
    physicalLedgerCount: 256,
    publicTableCount: 280,
    observedAt: new Date(STARTED_AT + 1000).toISOString(),
    sessions: {
      applicationClients: 0,
      unclassifiedClients: 0,
      activeApplicationTransactions: 0,
      activeUnclassifiedTransactions: 0,
    },
    ...overrides,
  }
}

function harness({ environment = target(), sources, proof = before(), releaseSha = SHA } = {}) {
  let sourceReads = 0
  let readbacks = 0
  let deploys = 0
  let clockReads = 0
  const sourceSequence = sources ?? [{ head: SHA, status: '', manifestHash: MANIFEST_HASH }]
  return {
    counts: () => ({ sourceReads, readbacks, deploys }),
    run: () =>
      runProductionMigration({
        releaseSha,
        environment,
        inspectSource: async () =>
          sourceSequence[Math.min(sourceReads++, sourceSequence.length - 1)],
        readBefore: async () => {
          readbacks++
          return proof
        },
        deploy: async () => {
          deploys++
        },
        now: () => STARTED_AT + 2000 * clockReads++,
      }),
  }
}

test('admits the pinned production target and a fresh v2 before-readback before deploy', async () => {
  const caseUnderTest = harness()
  await caseUnderTest.run()
  assert.deepEqual(caseUnderTest.counts(), { sourceReads: 2, readbacks: 1, deploys: 1 })
})

test('refuses wrong project, environment, database, protocol, or session connection before reading', async () => {
  const rejected = [
    { RAILWAY_PROJECT_ID: 'wrong' },
    { RAILWAY_ENVIRONMENT_ID: 'wrong' },
    { RAILWAY_ENVIRONMENT: 'staging' },
    { DATABASE_URL: 'postgresql://postgres@other.invalid/postgres' },
    { DIRECT_DATABASE_URL: 'https://db.invalid/postgres' },
    { DATABASE_URL: `postgresql://postgres@db.${PRODUCTION_DATABASE}.supabase.co/other` },
    { DATABASE_URL: `postgresql://postgres@db.${PRODUCTION_DATABASE}.supabase.co:6543/postgres` },
  ]
  for (const override of rejected) {
    const caseUnderTest = harness({ environment: target(override) })
    await assert.rejects(caseUnderTest.run())
    assert.deepEqual(caseUnderTest.counts(), { sourceReads: 0, readbacks: 0, deploys: 0 })
  }
  assert.doesNotThrow(() => assertProductionMigrationTarget(target()))
})

test('refuses invalid release SHA, wrong HEAD, dirty tree, and malformed manifest hash', async () => {
  for (const candidate of [
    { releaseSha: 'short' },
    { sources: [{ head: OTHER_SHA, status: '', manifestHash: MANIFEST_HASH }] },
    { sources: [{ head: SHA, status: ' M package.json', manifestHash: MANIFEST_HASH }] },
    { sources: [{ head: SHA, status: '', manifestHash: 'short' }] },
  ]) {
    const caseUnderTest = harness(candidate)
    await assert.rejects(caseUnderTest.run())
    assert.equal(caseUnderTest.counts().readbacks, 0)
    assert.equal(caseUnderTest.counts().deploys, 0)
  }
})

test('refuses old, stale, mismatched, or writer-active before-readbacks', async () => {
  const rejected = [
    { schema: 'torchiko-release267-preservation/v1' },
    { hashVersion: 1 },
    { target: 'staging' },
    { production: false },
    { phase: 'after' },
    { releaseSha: OTHER_SHA },
    { manifestHash: 'd'.repeat(64) },
    { project: 'wrong' },
    { environmentId: 'wrong' },
    { databaseResource: 'wrong' },
    { activeLedgerCount: 254 },
    { physicalLedgerCount: 255 },
    { publicTableCount: 279 },
    { observedAt: new Date(STARTED_AT - 1).toISOString() },
    { observedAt: new Date(STARTED_AT - 60_001).toISOString() },
    { observedAt: new Date(STARTED_AT + 3000).toISOString() },
    { sessions: { ...before().sessions, activeApplicationTransactions: 1 } },
    { sessions: { ...before().sessions, unclassifiedClients: 1 } },
  ]
  for (const override of rejected) {
    const caseUnderTest = harness({ proof: before(override) })
    await assert.rejects(caseUnderTest.run())
    assert.equal(caseUnderTest.counts().deploys, 0)
  }
})

test('refuses source drift after readback', async () => {
  const admitted = { head: SHA, status: '', manifestHash: MANIFEST_HASH }
  for (const changed of [
    { ...admitted, head: OTHER_SHA },
    { ...admitted, status: ' M package.json' },
    { ...admitted, manifestHash: 'd'.repeat(64) },
  ]) {
    const caseUnderTest = harness({ sources: [admitted, changed] })
    await assert.rejects(caseUnderTest.run())
    assert.deepEqual(caseUnderTest.counts(), { sourceReads: 2, readbacks: 1, deploys: 0 })
  }
})

test('target refusal does not print connection values', async () => {
  const marker = 'CONNECTION_VALUE_MUST_STAY_PRIVATE'
  const caseUnderTest = harness({
    environment: target({ DATABASE_URL: `postgresql://postgres:${marker}@wrong.invalid/postgres` }),
  })
  await assert.rejects(caseUnderTest.run(), (error) => {
    assert.doesNotMatch(String(error.stack), new RegExp(marker, 'u'))
    return true
  })
  assert.equal(caseUnderTest.counts().deploys, 0)
})
