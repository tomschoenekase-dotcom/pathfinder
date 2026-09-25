import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readMigrationManifest } from './run-staging-migration-predeploy.mjs'
import {
  initializeDispositionJournal,
  appendDispositionJournal,
  dispositionSha256,
} from './lib/guest-conversation-disposition-journal.mjs'
import {
  validateDispositionMaintenancePlan,
  runDispositionMaintenance,
  verifyDispositionDatabaseSource,
} from './lib/guest-conversation-disposition-maintenance.mjs'
import { GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256 as policyHash } from '../packages/config/src/guest-conversation-disposition-policy.runtime.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const operationId = 'd4888a2e-dc80-4a52-b204-676421454a52'

test('251 maintenance source verification accepts the exact current ledger and refuses drift before body reads', async () => {
  const manifest = await readMigrationManifest(join(root, 'packages/db/prisma'))
  const rows = manifest.names.map((migration_name) => ({
    migration_name,
    checksum: manifest.ledgerChecksums.get(migration_name),
    finished_at: '2026-09-12T00:00:00Z',
    rolled_back_at: null,
    logs: null,
  }))
  const sql = await readFile(
    join(root, 'packages/db/prisma/migrations', manifest.names[248], 'migration.sql'),
    'utf8',
  )
  const functions = [
    ...sql.matchAll(
      /CREATE(?: OR REPLACE)? FUNCTION (?:public\.)?(pathfinder_[a-z_]+)\([^]*?\bAS \$\$([^]*?)\$\$;/gu,
    ),
  ].map((match) => ({ name: match[1], sha256: dispositionSha256(match[2]) }))
  let calls = 0
  await verifyDispositionDatabaseSource({
    query: async () =>
      [rows, functions, { tables: 268, invalidIndexes: 0, unvalidatedConstraints: 0 }][calls++],
  })
  assert.equal(calls, 3)
  for (const [index, patch] of [
    [247, { checksum: '0'.repeat(64) }],
    [248, { checksum: '0'.repeat(64) }],
    [249, { checksum: '0'.repeat(64) }],
    [250, { checksum: '0'.repeat(64) }],
    [248, { finished_at: null }],
    [248, { logs: 'synthetic failure' }],
  ]) {
    const invalid = structuredClone(rows)
    Object.assign(invalid[index], patch)
    calls = 0
    await assert.rejects(
      verifyDispositionDatabaseSource({
        query: async () => {
          calls++
          return invalid
        },
      }),
      /checksum|unfinished|logs are non-empty|ledger/u,
    )
    assert.equal(calls, 1)
  }
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pathfinder-synthetic-maintenance-'))
  const journalPath = join(dir, 'journal.jsonl')
  await initializeDispositionJournal(journalPath)
  const now = Date.now(),
    observedUtc = new Date(now).toISOString(),
    actorId = 'synthetic-operator'
  const target = {
    database: 'pathfinder_disposable_guest_lifecycle_000000000000',
    role: 'guest_maintenance',
    databaseOid: '12345',
    systemIdentifier: '123456789',
    postmasterStartedAt: '2026-09-12T00:00:00.000000Z',
  }
  const evidence = {}
  for (const [name, value] of Object.entries({
    servicesStopped: {
      version: 'guest-disposition-stopped-services-v1',
      actorId,
      observedUtc,
      target,
      allWritersStopped: true,
      automaticRestartsPaused: true,
      inMemoryCopiesRetired: true,
      outstandingProviderWorkSettled: true,
    },
    journalCustody: {
      version: 'guest-disposition-journal-custody-v1',
      actorId,
      observedUtc,
      journalPath,
      highWaterSha256: '0'.repeat(64),
      protectedRestoreRoots: [join(dir, 'synthetic-db')],
      custodyReferenceSha256: '4'.repeat(64),
    },
  })) {
    const path = join(dir, `${name}.json`),
      raw = JSON.stringify(value)
    await writeFile(path, raw, { flag: 'wx' })
    evidence[name] = { path, sha256: dispositionSha256(raw) }
  }
  const manifest = await readMigrationManifest(join(root, 'packages/db/prisma'))
  const files = [
    'scripts/lib/guest-conversation-disposition-maintenance.mjs',
    'scripts/lib/guest-conversation-disposition-journal.mjs',
    'scripts/lib/guest-conversation-disposition-psql.mjs',
    'scripts/guest-conversation-disposition-maintenance.mjs',
    'scripts/run-staging-migration-predeploy.mjs',
    'packages/contracts/src/guest-conversation-disposition.ts',
    'packages/contracts/src/guest-conversation-disposition.runtime.mjs',
    'packages/config/src/guest-conversation-disposition-policy.ts',
    'packages/config/src/guest-conversation-disposition-policy.runtime.mjs',
    ...manifest.names.map((name) => `packages/db/prisma/migrations/${name}/migration.sql`),
  ]
  const sourceBindings = await Promise.all(
    files.map(async (path) => ({
      path: resolve(root, path),
      sha256: dispositionSha256(await readFile(resolve(root, path))),
    })),
  )
  const plan = {
    version: 'guest-disposition-maintenance-v1',
    mode: 'APPLY',
    target,
    journalPath,
    expectedHeadSha256: '0'.repeat(64),
    operationId,
    requestSha256: '1'.repeat(64),
    operator: {
      actorId,
      confirmedAt: observedUtc,
      holdAssessments: [{ operationId, referenceSha256: '2'.repeat(64), status: 'NO_KNOWN_HOLD' }],
    },
    evidence,
    sourceBindings,
    recoverClosedAdmission: true,
    reopenAfterReconciliation: false,
  }
  return { dir, plan, now }
}

test('actual default CLI checks a bound local plan without psql, database or journal writes', async () => {
  const { dir, plan } = await fixture()
  const raw = JSON.stringify(plan)
  const file = join(dir, 'plan.json')
  await writeFile(file, raw, { flag: 'wx' })
  const before = await readFile(plan.journalPath)
  const child = spawnSync(
    process.execPath,
    [
      join(root, 'scripts/guest-conversation-disposition-maintenance.mjs'),
      '--plan',
      file,
      '--plan-sha256',
      dispositionSha256(raw),
    ],
    { encoding: 'utf8', timeout: 15000, env: { SystemRoot: process.env.SystemRoot, PATH: '' } },
  )
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stderr, '')
  assert.deepEqual(JSON.parse(child.stdout), {
    status: 'LOCAL_PLAN_CHECKED',
    networkOrDatabaseContact: false,
    planSha256: dispositionSha256(raw),
  })
  assert.deepEqual(await readFile(plan.journalPath), before)
})
for (const mode of ['stale', 'held', 'source-drift']) {
  test(`preflight ${mode} refuses and closes the already-owned control channel before target admission`, async () => {
    const { dir, plan, now } = await fixture()
    let closes = 0,
      queries = 0,
      connects = 0
    if (mode === 'stale') plan.operator.confirmedAt = new Date(now - 300001).toISOString()
    if (mode === 'held') plan.operator.holdAssessments[0].status = 'HOLD_PRESENT'
    if (mode === 'source-drift') plan.sourceBindings[0].sha256 = 'f'.repeat(64)
    await assert.rejects(
      runDispositionMaintenance({
        plan,
        now: () => now,
        outputDirectory: dir,
        control: {
          query: async () => {
            queries++
            throw new Error('unexpected')
          },
          close: async () => {
            closes++
          },
        },
        connectTarget: async () => {
          connects++
          throw new Error('unexpected')
        },
      }),
      /REFUSED/u,
    )
    assert.deepEqual({ closes, queries, connects }, { closes: 1, queries: 0, connects: 0 })
  })
}
test('already-journaled APPLY requires the exact requested hash before connecting or mutating', async () => {
  const { dir, plan, now } = await fixture()
  const request = {
    version: 'guest-conversation-disposition-v1',
    operationId,
    tenantId: 'synthetic-tenant',
    venueId: 'synthetic-venue',
    sessionId: 'synthetic-session',
    expectedPolicyVersion: 'guest-conversations-terminal-text-v1',
    expectedPolicySha256: policyHash,
    basis: { kind: 'RETENTION_EXPIRY' },
  }
  const intent = {
    version: 'guest-disposition-intent-v1',
    operationId,
    tenantId: request.tenantId,
    venueId: request.venueId,
    sessionId: request.sessionId,
    requestSha256: '3'.repeat(64),
    policyVersion: request.expectedPolicyVersion,
    policySha256: policyHash,
    effectiveCutoffUtc: '2025-01-01T00:00:00Z',
    retiredTokenDigest: '4'.repeat(64),
    affected: {
      sessions: 1,
      messages: 0,
      turns: 0,
      engagementResponses: 0,
      feedback: 0,
      analyticsEvents: 0,
    },
    request,
    authority: {
      version: 'guest-disposition-authority-v1',
      actorId: plan.operator.actorId,
      actorRole: 'PLATFORM_ADMIN',
      policyVersion: request.expectedPolicyVersion,
      policySha256: policyHash,
      retentionDays: 365,
      holdAssessment: { status: 'NO_KNOWN_HOLD', referenceSha256: '2'.repeat(64) },
      basis: request.basis,
    },
  }
  const journal = await appendDispositionJournal(
    plan.journalPath,
    plan.expectedHeadSha256,
    'INTENT',
    intent,
  )
  plan.expectedHeadSha256 = journal.headSha256
  const binding = plan.evidence.journalCustody,
    prior = JSON.parse(await readFile(binding.path))
  const path = join(dir, 'custody-current.json'),
    raw = JSON.stringify({ ...prior, highWaterSha256: journal.headSha256 })
  await writeFile(path, raw, { flag: 'wx' })
  plan.evidence.journalCustody = { path, sha256: dispositionSha256(raw) }
  await validateDispositionMaintenancePlan(plan, now)
  let closed = false
  await assert.rejects(
    runDispositionMaintenance({
      plan,
      now: () => now,
      outputDirectory: dir,
      control: {
        close: async () => {
          closed = true
        },
        query: async () => {
          throw new Error('unexpected query')
        },
      },
      connectTarget: async () => {
        throw new Error('unexpected connect')
      },
    }),
    /selected existing intent request hash mismatch/u,
  )
  assert.equal(closed, true)
})
