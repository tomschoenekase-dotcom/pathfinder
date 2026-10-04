import assert from 'node:assert/strict'
import { EXPECTED } from '../run-staging-migration-predeploy.mjs'

export const PRODUCTION_PROJECT = '8621111a-4ac8-4d88-9566-4627c8a02059'
export const PRODUCTION_ENVIRONMENT = 'ad140532-61bb-4355-a7e3-ebb2a54d743f'
export const PRODUCTION_DATABASE = 'zpacmfkomonxeqdiadtz'

export function assertProductionMigrationTarget(environment) {
  assert.equal(environment.RAILWAY_PROJECT_ID, PRODUCTION_PROJECT, 'production-project-refused')
  assert.equal(
    environment.RAILWAY_ENVIRONMENT_ID,
    PRODUCTION_ENVIRONMENT,
    'production-environment-refused',
  )
  assert.equal(environment.RAILWAY_ENVIRONMENT, 'production', 'production-environment-name-refused')
  // Do not include connection values in errors or command arguments.
  for (const key of ['DATABASE_URL', 'DIRECT_DATABASE_URL']) {
    let url
    try {
      url = new URL(environment[key])
    } catch {
      throw new Error('production-database-url-required')
    }
    const direct = url.hostname === `db.${PRODUCTION_DATABASE}.supabase.co`
    const pooler =
      url.hostname.endsWith('.pooler.supabase.com') &&
      decodeURIComponent(url.username) === `postgres.${PRODUCTION_DATABASE}`
    assert.ok(direct || pooler, 'production-database-identity-refused')
    assert.ok(
      ['postgres:', 'postgresql:'].includes(url.protocol),
      'production-database-protocol-refused',
    )
    assert.equal(decodeURIComponent(url.pathname), '/postgres', 'production-database-name-refused')
    assert.ok(!url.port || url.port === '5432', 'production-session-connection-required')
  }
}

export function assertFreshProductionReadback(proof, { releaseSha, manifestHash, startedAt, now }) {
  assert.equal(
    proof.schema,
    'torchiko-release267-preservation/v2',
    'before-readback-schema-refused',
  )
  assert.equal(proof.hashVersion, 2, 'before-readback-hash-version-refused')
  assert.equal(proof.target, 'production', 'before-readback-target-refused')
  assert.equal(proof.production, true, 'before-readback-production-required')
  assert.equal(proof.phase, 'before', 'before-readback-phase-refused')
  assert.equal(proof.releaseSha, releaseSha, 'before-readback-release-sha-mismatch')
  assert.equal(proof.manifestHash, manifestHash, 'before-readback-manifest-mismatch')
  assert.equal(proof.project, PRODUCTION_PROJECT, 'before-readback-project-refused')
  assert.equal(proof.environmentId, PRODUCTION_ENVIRONMENT, 'before-readback-environment-refused')
  assert.equal(proof.databaseResource, PRODUCTION_DATABASE, 'before-readback-database-refused')
  assert.equal(proof.activeLedgerCount, 255, 'before-readback-active-ledger-refused')
  assert.equal(proof.physicalLedgerCount, 256, 'before-readback-physical-ledger-refused')
  assert.equal(proof.publicTableCount, 280, 'before-readback-table-count-refused')
  const observed = Date.parse(proof.observedAt)
  assert.ok(
    Number.isFinite(observed) &&
      observed >= startedAt &&
      observed <= now &&
      now - observed <= 60_000,
    'before-readback-not-fresh',
  )
  for (const key of [
    'applicationClients',
    'unclassifiedClients',
    'activeApplicationTransactions',
    'activeUnclassifiedTransactions',
  ]) {
    assert.equal(proof.sessions?.[key], 0, 'before-readback-writers-remain')
  }
}

// The command supplies real Git, manifest, readback and migration adapters. Tests use inert adapters.
// Recheck source after the readback so a concurrent checkout change cannot use stale admission.
export async function runProductionMigration({
  releaseSha,
  environment,
  inspectSource,
  readBefore,
  deploy,
  now = Date.now,
}) {
  assert.match(releaseSha ?? '', /^[a-f0-9]{40}$/u, 'full-release-sha-required')
  assertProductionMigrationTarget(environment)
  const inspect = async () => {
    const source = await inspectSource()
    assert.equal(source.head, releaseSha, 'production-head-release-sha-mismatch')
    assert.equal(source.status, '', 'production-clean-tree-required')
    assert.equal(source.manifestHash, EXPECTED.manifestHash, 'production-frozen-manifest-required')
    return source
  }
  const source = await inspect()
  const startedAt = now()
  const proof = await readBefore()
  const checked = await inspect()
  assert.equal(checked.manifestHash, source.manifestHash, 'production-manifest-changed')
  assertFreshProductionReadback(proof, {
    releaseSha,
    manifestHash: source.manifestHash,
    startedAt,
    now: now(),
  })
  await deploy()
}
