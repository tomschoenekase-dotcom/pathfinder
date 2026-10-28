import { historicalRelease269Fixture } from './test-support/historical-staging-manifest.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  QUEUE_PRESERVATION_SCHEMA,
  QUEUE_PRESERVATION_APPROVAL,
} from './lib/release269-queue-preservation.mjs'
import { RELEASE269_QUEUE_BASE_NAMES } from './lib/release269-queue-readback.mjs'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import {
  readMigrationManifest,
  EXPECTED,
  stagingPredeployExitClassification,
} from './run-staging-migration-predeploy.mjs'
import { RELEASE269 } from './lib/release269-migration-contract.mjs'
import {
  runRelease269,
  hashJson,
  RELEASE269_APPROVAL,
  RELEASE269_PROOF_SCHEMA,
  assertRelease269Drain,
  assertRelease269Preserved,
} from './lib/release269-runtime-admission.mjs'
import {
  PRODUCTION_DATABASE,
  PRODUCTION_ENVIRONMENT,
  PRODUCTION_PROJECT,
} from './lib/production-migration-admission.mjs'
import {
  tableHashSql,
  AFFECTED_EVENT_ROWS_SQL,
  summarizeRelease269Clients,
  readRelease269Clients,
  readRelease269Snapshot,
} from './lib/release269-readback.mjs'
import {
  release269PrismaDirectory,
  release269MigrationChildEnvironment,
} from './run-release269-migration.mjs'
import path from 'node:path'

const manifest = historicalRelease269Fixture(
  await readMigrationManifest(fileURLToPath(new URL('../packages/db/prisma', import.meta.url))),
)
const sha = 'a'.repeat(40)
const time = Date.parse('2026-10-26T04:00:00.000Z')
const iso = (offset) => new Date(time + offset).toISOString()
const digest = (text) => hashJson(text)

test('production pins the reviewed Prisma directory and migration children reject inherited overrides', () => {
  const root = path.resolve('synthetic-release-root')
  const pinned = path.join(root, 'packages/db/prisma')
  assert.equal(release269PrismaDirectory(root, 'production', {}), pinned)
  assert.equal(
    release269PrismaDirectory(root, 'production', { PATHFINDER_PRISMA_DIR: pinned }),
    pinned,
  )
  assert.throws(
    () =>
      release269PrismaDirectory(root, 'production', {
        PATHFINDER_PRISMA_DIR: path.resolve('outside'),
      }),
    /directory-refused/u,
  )
  const environment = {
    DATABASE_URL: 'postgresql://user:synthetic@localhost:5432/synthetic',
    DIRECT_DATABASE_URL: 'postgresql://user:synthetic@localhost:5432/synthetic',
    Database_Url: 'unapproved',
    NODE_OPTIONS: '--require unsafe.js',
    Node_Path: 'unsafe',
    PRISMA_CONFIG_PATH: 'unsafe-config',
    PRISMA_SCHEMA_ENGINE_BINARY: 'unsafe-engine',
    PRISMA_QUERY_ENGINE_LIBRARY: '/app/prisma-engine/query-engine.node',
    PGSERVICEFILE: 'unsafe-service',
    SAFE_VALUE: 'retained',
  }
  for (const target of ['production', 'staging']) {
    const child = release269MigrationChildEnvironment(environment, sha, target).environment
    assert.equal(child.SAFE_VALUE, 'retained')
    for (const key of [
      'Database_Url',
      'NODE_OPTIONS',
      'Node_Path',
      'PRISMA_CONFIG_PATH',
      'PRISMA_SCHEMA_ENGINE_BINARY',
      'PGSERVICEFILE',
    ])
      assert.equal(child[key], undefined)
    assert.equal(
      child.PRISMA_QUERY_ENGINE_LIBRARY,
      target === 'staging' ? '/app/prisma-engine/query-engine.node' : undefined,
    )
    assert.match(new URL(child.DIRECT_DATABASE_URL).searchParams.get('application_name'), /^tkm:/u)
  }
  assert.throws(
    () =>
      release269MigrationChildEnvironment(
        { ...environment, PRISMA_QUERY_ENGINE_LIBRARY: '/outside/engine' },
        sha,
        'staging',
      ),
    /query-engine-refused/u,
  )
  assert.equal(environment.NODE_OPTIONS, '--require unsafe.js')
})

function snapshot(target = 'production', complete = false) {
  const names = [
    'content_versions',
    'embedding_dispatches',
    'operational_fact_content',
    'venue_knowledge_entries',
    ...Array.from({ length: 292 }, (_, index) => `table_${String(index).padStart(3, '0')}`),
  ].sort()
  const tables = names.map((name) => ({
    name,
    columns: ['id', 'content', 'updated_at'],
    count: '2',
    hash: digest(name),
  }))
  const ledger = manifest.names.slice(0, complete ? 269 : 267).map((migration_name, index) => ({
    id: `ledger-${index}`,
    migration_name,
    checksum: manifest.ledgerChecksums.get(migration_name),
    finished_at: iso(-10_000),
    rolled_back_at: null,
    logs: '',
    rowHash: digest(migration_name),
  }))
  const security = [{ identity: 'relation:content_versions', hash: digest('owner/acl') }]
  if (complete)
    security.push(
      {
        identity: 'function:operational_fact_applicability_ids_valid(ids text[])',
        hash: digest('new function1'),
      },
      {
        identity:
          'function:universal_content_event_projection_v1(p_description text, p_starts_at timestamp without time zone, p_ends_at timestamp without time zone)',
        hash: digest('new function2'),
      },
    )
  return {
    schema: RELEASE269_PROOF_SCHEMA,
    target,
    releaseSha: sha,
    databaseResource: target === 'production' ? PRODUCTION_DATABASE : EXPECTED.databaseResourceId,
    queueResourceIdentity: 'fixture-queue-resource',
    manifestHash: RELEASE269.manifestHash,
    observedAt: iso(1000),
    otherClientSessions: 0,
    approvedIdleProviderClientSessions: 0,
    blockingClientSessions: 0,
    activeOrTransactionalClientSessions: 0,
    ledger,
    activeLedgerCount: ledger.length,
    physicalLedgerCount: ledger.length,
    physicalLedgerHash: hashJson(ledger.map(({ id, rowHash }) => ({ id, rowHash }))),
    publicTableCount: 297,
    tables,
    dataHash: hashJson(tables),
    schemaHash: digest(complete ? '269-schema' : '267-schema'),
    physicalSchemaHash: digest(complete ? '269-physical-schema' : '267-physical-schema'),
    policyHash: digest('policies and RLS'),
    sequenceStateHash: digest('sequence state'),
    security,
    securityHash: hashJson(security),
    newFunctionPrivilegesHash: digest(complete ? 'new ACLs' : 'no new ACLs'),
    invalidIndexes: 0,
    unvalidatedConstraints: 0,
    affectedEventRows: 0,
    applicabilityColumnsPresent: complete ? 3 : 0,
    applicabilitySchemaValid: complete,
    applicabilityDefaultsValid: complete,
    eventFunctionPresent: complete,
    weeklyDigestFingerprintValid: true,
    disabledAppPlansValid: true,
  }
}

function proof(before) {
  return {
    schema: RELEASE269_PROOF_SCHEMA,
    target: before.target,
    releaseSha: sha,
    databaseResource: before.databaseResource,
    manifestHash: RELEASE269.manifestHash,
    historicalRollbackRows: [],
    dataPolicy: 'preserve-existing',
    approved: true,
    migrationScope: '267-to-269-zero-event-rewrite',
    backupStorageResource: 'fixture-private-workstation',
    backupSha256: digest('archive'),
    restoreProofSha256: digest('restore'),
    rehearsalProofSha256: digest('rehearsal'),
    ownershipAclArchiveEvidenceSha256: digest('archive ownership and ACL retention'),
    restoreOwnershipAclRemappingSha256: digest('local owner remapping record'),
    archiveRetainsOwnershipAndPrivileges: true,
    restoreScope: 'public-schema',
    rehearsedOriginalSecurityPreserved: true,
    drainedAt: iso(-40_000),
    backupCreatedAt: iso(-30_000),
    restoreVerifiedAt: iso(-20_000),
    rehearsalVerifiedAt: iso(-10_000),
    restoredDataHash: before.dataHash,
    restoredPhysicalLedgerHash: before.physicalLedgerHash,
    restoredSchemaHash: before.schemaHash,
    rehearsedSchemaHash: digest('269-schema'),
    rehearsedNewFunctionPrivilegesHash: digest('new ACLs'),
    restoredSequenceStateHash: before.sequenceStateHash,
    rehearsedSequenceStateHash: before.sequenceStateHash,
    rehearsedOriginalDataHash: before.dataHash,
    rehearsedActiveLedgerCount: 269,
    rehearsedPhysicalLedgerCount: before.physicalLedgerCount + 2,
    rehearsedAffectedEventRows: 0,
    rehearsedNoPendingReplay: true,
  }
}

function harness(target = 'production') {
  const before = snapshot(target)
  const after = snapshot(target, true)
  const evidence = proof(before)
  const environment =
    target === 'production'
      ? {
          RAILWAY_PROJECT_ID: PRODUCTION_PROJECT,
          RAILWAY_ENVIRONMENT_ID: PRODUCTION_ENVIRONMENT,
          RAILWAY_ENVIRONMENT: 'production',
          DATABASE_URL: `postgresql://postgres@db.${PRODUCTION_DATABASE}.supabase.co:5432/postgres`,
          DIRECT_DATABASE_URL: `postgresql://postgres@db.${PRODUCTION_DATABASE}.supabase.co:5432/postgres`,
        }
      : {
          RAILWAY_ENVIRONMENT: 'staging',
          RAILWAY_ENVIRONMENT_ID: EXPECTED.environmentId,
          RAILWAY_SERVICE_ID: EXPECTED.serviceId,
          DATABASE_RESOURCE_ID: EXPECTED.databaseResourceId,
          RAILWAY_GIT_COMMIT_SHA: sha,
          DATABASE_URL: 'postgresql://fixture@database.railway.internal:5432/pathfinder_staging',
          DIRECT_DATABASE_URL:
            'postgresql://fixture@database.railway.internal:5432/pathfinder_staging',
          PATHFINDER_STAGING_MIGRATION_APPROVAL: RELEASE269_APPROVAL,
          PATHFINDER_ALLOW_STAGING_MIGRATIONS: '1',
          PATHFINDER_STAGING_MIGRATION_ONLY_HOLD: '1',
          PATHFINDER_CONFIRM_STAGING_DATA_POLICY: 'preserve-existing',
          PATHFINDER_STAGING_SPEND_CEILING_USD: '10',
          PATHFINDER_STAGING_DATABASE_RESOURCE: EXPECTED.databaseResourceId,
          PATHFINDER_CONFIRM_STAGING_DATABASE_RESOURCE: EXPECTED.databaseResourceId,
          PATHFINDER_CONFIRM_STAGING_DATABASE_HOST: 'database.railway.internal',
          PATHFINDER_CONFIRM_STAGING_DIRECT_DATABASE_HOST: 'database.railway.internal',
          PATHFINDER_CONFIRM_STAGING_DATABASE_NAME: 'pathfinder_staging',
          PATHFINDER_STAGING_BACKUP_RELEASE_SHA: sha,
          PATHFINDER_STAGING_BACKUP_DATABASE_RESOURCE: EXPECTED.databaseResourceId,
          PATHFINDER_STAGING_BACKUP_STORAGE_RESOURCE: evidence.backupStorageResource,
          PATHFINDER_CONFIRM_STAGING_BACKUP_STORAGE_RESOURCE: evidence.backupStorageResource,
          PATHFINDER_STAGING_BACKUP_LEDGER_COUNT: '267',
          PATHFINDER_STAGING_BACKUP_CREATED_AT: evidence.backupCreatedAt,
          PATHFINDER_STAGING_BACKUP_RESTORE_VERIFIED_AT: evidence.restoreVerifiedAt,
          PATHFINDER_STAGING_BACKUP_SHA256: evidence.backupSha256,
          PATHFINDER_STAGING_BACKUP_RESTORE_PROOF_SHA256: evidence.restoreProofSha256,
        }
  const queues = {
    schema: 'torchiko-release269-queue-drain/v1',
    target,
    releaseSha: sha,
    coverage: 'all-application-queues',
    resourceIdentity: before.queueResourceIdentity,
    observedAt: iso(1000),
    waiting: 0,
    active: 0,
    delayed: 0,
    prioritized: 0,
    waitingChildren: 0,
  }
  const events = []
  let deployed = false
  const options = {
    target,
    releaseSha: sha,
    environment,
    proof: evidence,
    inspectSource: async () => ({ head: sha, status: '', manifest }),
    readSnapshot: async () => structuredClone(deployed ? after : before),
    readQueues: async () => queues,
    deploy: async () => {
      deployed = true
      events.push('deploy')
    },
    record: async (phase) => events.push(phase),
    now: () => time + 2000,
  }
  // Every readback is produced after the same invocation starts.
  let clocks = 0
  options.now = () => (clocks++ === 0 ? time : time + 2000)
  return {
    before,
    after,
    evidence,
    environment,
    queues,
    events,
    options,
    run: () => runRelease269(options),
  }
}

test('exact production267→269 preserves all original data and physical history', async () => {
  const h = harness()
  assert.deepEqual(await h.run(), { state: 'complete269', changed: true })
  assert.deepEqual(h.events, ['before', 'armed', 'deploy', 'after', 'verified'])
})

test('logical restore equivalence never hides raw live catalog drift or admits old proofs', async () => {
  const h = harness()
  let reads = 0
  h.options.readSnapshot = async () => ({
    ...structuredClone(h.before),
    physicalSchemaHash: ++reads === 1 ? h.before.physicalSchemaHash : digest('catalog changed'),
  })
  await assert.rejects(h.run(), /prewrite-schema-or-security-drift/u)
  assert.ok(!h.events.includes('deploy'))
  const old = harness()
  old.evidence.schema = 'torchiko-release269-preservation/v1'
  await assert.rejects(old.run())
  assert.ok(!old.events.includes('deploy'))
})

test('reviewed dormant queue proof admits pending jobs but retains session and freshness gates', () => {
  const h = harness()
  const proof = {
    ...h.queues,
    schema: QUEUE_PRESERVATION_SCHEMA,
    approval: QUEUE_PRESERVATION_APPROVAL,
    firstObservedAt: new Date(Date.parse(h.queues.observedAt) - 30000).toISOString(),
    waiting: 6,
    delayed: 4,
    failed: 0,
    workers: 0,
    preserved: true,
    transport: 'EVAL_RO-and-CLIENT-LIST',
    registry: [...RELEASE269_QUEUE_BASE_NAMES],
    countsSha256: 'a'.repeat(64),
    jobsSha256: 'b'.repeat(64),
    canonicalSha256: 'c'.repeat(64),
  }
  const now = Date.parse(h.queues.observedAt)
  const scope = {
    target: 'production',
    releaseSha: h.queues.releaseSha,
    startedAt: now - 1000,
    now,
  }
  assert.doesNotThrow(() => assertRelease269Drain(h.before, proof, scope))
  assert.throws(() =>
    assertRelease269Drain({ ...h.before, blockingClientSessions: 1 }, proof, scope),
  )
  assert.throws(() => assertRelease269Drain(h.before, { ...proof, workers: 1 }, scope))
  assert.throws(() =>
    assertRelease269Drain(h.before, { ...proof, resourceIdentity: 'other' }, scope),
  )
  assert.throws(() => assertRelease269Drain(h.before, proof, { ...scope, now: now + 60001 }))
})

test('production requires known zero prioritized and waiting-children counts on both queue reads', async (t) => {
  for (const key of ['prioritized', 'waitingChildren']) {
    for (const rejectedRead of [1, 2]) {
      for (const value of [1, undefined, null, '0', -1, 0.5, NaN, false]) {
        await t.test(`${key}=${String(value)} on read ${rejectedRead}`, async () => {
          const h = harness('production')
          let reads = 0
          h.options.readQueues = async () => {
            const queues = { ...h.queues }
            if (++reads === rejectedRead) {
              if (value === undefined) delete queues[key]
              else queues[key] = value
            }
            return queues
          }
          await assert.rejects(h.run(), /queue-not-drained/u)
          assert.equal(reads, rejectedRead)
          assert.ok(!h.events.includes('armed'))
          assert.ok(!h.events.includes('deploy'))
        })
      }
    }
  }
})

test('production accepts all five pending states at zero while preserving failed history', async () => {
  const h = harness('production')
  h.queues.failed = 4
  let reads = 0
  h.options.readQueues = async () => {
    reads += 1
    return { ...h.queues }
  }
  assert.deepEqual(await h.run(), { state: 'complete269', changed: true })
  assert.equal(reads, 2)
  assert.equal(h.queues.failed, 4)
  assert.deepEqual(h.events, ['before', 'armed', 'deploy', 'after', 'verified'])
})

test('long repeatable-read scans keep their start timestamp and expire before migration', async (t) => {
  for (const scanMilliseconds of [1000, 60_001]) {
    await t.test(`${scanMilliseconds}ms preservation scan`, async () => {
      let clock = time
      let tableReads = 0
      let sessionReads = 0
      const transaction = {
        $executeRawUnsafe: async (sql) => {
          assert.ok(
            [
              'SET TRANSACTION READ ONLY',
              "SET LOCAL TIME ZONE 'UTC'",
              "SET LOCAL DateStyle = 'ISO, YMD'",
            ].includes(sql),
          )
          // Transaction setup is also part of the observation's age.
          if (sql === 'SET TRANSACTION READ ONLY') clock += 10
        },
        $queryRawUnsafe: async (sql) => {
          if (sql.includes('pg_stat_clear_snapshot()')) return [{ ignored: false }]
          if (sql.includes('FROM pg_stat_activity')) {
            sessionReads += 1
            return []
          }
          if (sql.includes('FROM public._prisma_migrations')) return []
          if (sql.includes('FROM pg_catalog.pg_tables')) return [{ tablename: 'synthetic_rows' }]
          if (sql.includes('FROM information_schema.columns'))
            return [{ table_name: 'synthetic_rows', column_name: 'id' }]
          if (sql.includes('row_to_json(original)')) {
            tableReads += 1
            clock += scanMilliseconds
            return [{ count: '0', hash: digest('empty synthetic rows') }]
          }
          if (sql === AFFECTED_EVENT_ROWS_SQL) return [{ count: 0 }]
          if (sql.includes('FROM public.product_plan_capabilities'))
            return [
              { plan_tier: 'free', enabled: false },
              { plan_tier: 'pro', enabled: false },
            ]
          // This inert database has no additional schema or security objects.
          if (
            /FROM (?:pg_constraint c|pg_index i|pg_proc p|pg_trigger t|pg_enum e|pg_policies|pg_class c|pg_views|pg_sequences|pg_namespace WHERE|pg_default_acl d)/u.test(
              sql,
            )
          )
            return []
          assert.fail('unexpected synthetic readback query')
        },
      }
      const database = {
        $transaction: async (read, options) => {
          assert.equal(options.isolationLevel, 'RepeatableRead')
          return read(transaction)
        },
      }
      // Exercise the actual collector timestamp through the full admission path;
      // unrelated schema/backup evidence comes from the complete release fixture.
      const h = harness('production')
      const collected = []
      const readSnapshot = h.options.readSnapshot
      h.options.readSnapshot = async () => {
        clock += 1000
        const observation = await readRelease269Snapshot(database, {}, { now: () => clock })
        collected.push(observation)
        return { ...(await readSnapshot()), observedAt: observation.observedAt }
      }
      h.options.now = () => clock
      h.options.readQueues = async () => ({
        ...h.queues,
        observedAt: new Date(clock).toISOString(),
      })
      if (scanMilliseconds > 60_000) {
        await assert.rejects(h.run(), /readback-not-fresh/u)
        assert.ok(!h.events.includes('deploy'))
      } else assert.deepEqual(await h.run(), { state: 'complete269', changed: true })
      assert.equal(collected[0].observedAt, iso(1000))
      assert.equal(collected[0].tables[0].count, '0')
      assert.equal(collected.length, scanMilliseconds > 60_000 ? 1 : 3)
      assert.equal(tableReads, collected.length)
      assert.equal(sessionReads, collected.length * 2)
    })
  }
})

test('final source inspection and armed-journal delays cannot outlive the freshness window', async (t) => {
  for (const phase of ['final-inspect', 'armed-record']) {
    for (const delay of [1000, 60_001]) {
      await t.test(`${phase} delayed ${delay}ms`, async () => {
        const h = harness('production')
        let clock = time + 2000
        let firstClock = true
        h.options.now = () => {
          if (firstClock) {
            firstClock = false
            return time
          }
          return clock
        }
        let inspections = 0
        const inspect = h.options.inspectSource
        h.options.inspectSource = async () => {
          if (++inspections === 3 && phase === 'final-inspect') clock += delay
          return inspect()
        }
        const record = h.options.record
        h.options.record = async (name, evidence) => {
          await record(name, evidence)
          if (name === 'armed' && phase === 'armed-record') clock += delay
        }
        if (delay > 60_000) {
          await assert.rejects(h.run(), /readback-not-fresh/u)
          assert.ok(!h.events.includes('deploy'))
          assert.ok(!h.events.includes('after'))
        } else assert.deepEqual(await h.run(), { state: 'complete269', changed: true })
        assert.equal(inspections, 3)
        assert.ok(h.events.includes('armed'))
      })
    }
  }
})

test('queues are freshly read again after the last database snapshot and a late job stops deploy', async () => {
  for (const lateJob of [false, true]) {
    const h = harness()
    const ordering = []
    const originalRead = h.options.readSnapshot
    h.options.readSnapshot = async () => {
      ordering.push('database')
      return originalRead()
    }
    h.options.readQueues = async () => {
      ordering.push('queues')
      const second = ordering.filter((item) => item === 'queues').length === 2
      return { ...h.queues, waiting: second && lateJob ? 1 : 0 }
    }
    if (lateJob) {
      await assert.rejects(h.run(), /queue-not-drained/u)
      assert.ok(!h.events.includes('deploy'))
    } else await h.run()
    assert.deepEqual(ordering.slice(0, 4), ['database', 'queues', 'database', 'queues'])
  }
})

test('staging verified migration remains held; failures never become held success', async () => {
  const h = harness('staging')
  await assert.rejects(h.run(), (error) => stagingPredeployExitClassification(error).exitCode === 2)
  assert.ok(h.events.includes('verified'))
  for (const mutate of [
    (x) => {
      x.environment.PATHFINDER_STAGING_MIGRATION_ONLY_HOLD = '0'
    },
    (x) => {
      x.environment.PATHFINDER_ALLOW_STAGING_MIGRATIONS = '0'
    },
    (x) => {
      x.environment.PATHFINDER_STAGING_MIGRATION_APPROVAL = EXPECTED.approval
    },
    (x) => {
      x.environment.PATHFINDER_CONFIRM_STAGING_DATA_POLICY = 'synthetic-only'
    },
  ]) {
    const invalid = harness('staging')
    mutate(invalid)
    await assert.rejects(
      invalid.run(),
      (error) => stagingPredeployExitClassification(error).exitCode === 1,
    )
    assert.ok(!invalid.events.includes('deploy'))
  }
})

test('positive, unknown, string or absent affected event counts stop before mutation', async () => {
  for (const value of [1, -1, null, undefined, '0', NaN]) {
    const h = harness()
    h.before.affectedEventRows = value
    await assert.rejects(h.run(), /event-rewrite-not-admitted/u)
    assert.ok(!h.events.includes('deploy'))
  }
})

test('fresh backup, matching restore and rehearsal are independently mandatory', async () => {
  const mutations = [
    { approved: false },
    { backupCreatedAt: iso(-90_000_000), drainedAt: iso(-91_000_000) },
    { backupCreatedAt: iso(3000) },
    { restoredDataHash: digest('other') },
    { restoredPhysicalLedgerHash: digest('other') },
    { restoredSchemaHash: digest('other') },
    { rehearsedOriginalDataHash: digest('other') },
    { rehearsedNoPendingReplay: false },
    { rehearsedAffectedEventRows: 1 },
    { rehearsalProofSha256: undefined },
    { backupStorageResource: PRODUCTION_DATABASE },
    { releaseSha: 'b'.repeat(40) },
  ]
  for (const patch of mutations) {
    const h = harness()
    Object.assign(h.evidence, patch)
    await assert.rejects(h.run())
    assert.ok(!h.events.includes('deploy'))
  }
})

test('same-invocation readback, drained sessions, and complete fresh queue evidence are required', async () => {
  for (const mutate of [
    (h) => {
      h.before.observedAt = iso(-1)
    },
    (h) => {
      h.before.otherClientSessions = 1
    },
    (h) => {
      h.before.otherClientSessions = undefined
    },
    (h) => {
      h.queues.active = 1
    },
    (h) => {
      delete h.queues.delayed
    },
    (h) => {
      h.queues.coverage = 'sample'
    },
    (h) => {
      h.queues.observedAt = iso(-70_000)
    },
    (h) => {
      h.queues.resourceIdentity = 'other'
    },
  ]) {
    const h = harness()
    mutate(h)
    await assert.rejects(h.run())
    assert.ok(!h.events.includes('deploy'))
  }
})

test('partial ledger, tampered source and concurrent prewrite changes refuse mutation', async () => {
  for (const mutate of [
    (h) => {
      h.before.ledger.push(snapshot('production', true).ledger[267])
      h.before.activeLedgerCount++
      h.before.physicalLedgerCount++
      h.before.physicalLedgerHash = hashJson(
        h.before.ledger.map(({ id, rowHash }) => ({ id, rowHash })),
      )
    },
    (h) => {
      h.before.ledger[0].checksum = '0'.repeat(64)
    },
    (h) => {
      h.before.ledger[0].logs = 'failed'
    },
    (h) => {
      h.options.inspectSource = async () => ({ head: sha, status: ' M file', manifest })
    },
    (h) => {
      let calls = 0
      h.options.inspectSource = async () => ({
        head: ++calls > 1 ? 'b'.repeat(40) : sha,
        status: '',
        manifest,
      })
    },
    (h) => {
      let reads = 0
      h.options.readSnapshot = async () => {
        const s = structuredClone(h.before)
        if (++reads > 1) {
          s.tables[0].hash = digest('changed')
          s.dataHash = hashJson(s.tables)
        }
        return s
      }
    },
  ]) {
    const h = harness()
    mutate(h)
    await assert.rejects(h.run())
    assert.ok(!h.events.includes('deploy'))
  }
})

test('all tables including history/outbox and physical ledger rows are protected after migration', async () => {
  for (const name of [
    'content_versions',
    'embedding_dispatches',
    'venue_knowledge_entries',
    'operational_fact_content',
  ]) {
    const h = harness()
    h.after.tables.find((row) => row.name === name).hash = digest('changed')
    h.after.dataHash = hashJson(h.after.tables)
    await assert.rejects(h.run(), /original-data-changed/u)
    assert.ok(h.events.includes('after'))
    assert.ok(!h.events.includes('verified'))
  }
  const h = harness()
  h.after.ledger[0].rowHash = digest('modified physical ledger')
  h.after.physicalLedgerHash = hashJson(h.after.ledger.map(({ id, rowHash }) => ({ id, rowHash })))
  await assert.rejects(h.run(), /physical-ledger-changed/u)
})

test('a reviewed historical rollback is explicitly retained, never silently filtered', async () => {
  const h = harness()
  const row = {
    ...h.before.ledger.find(
      (item) => item.migration_name === '20260912080000_add_guest_conversation_disposition',
    ),
    id: 'historical-rollback',
    rolled_back_at: iso(-20_000),
    rowHash: digest('historical-physical-row'),
  }
  for (const snapshot of [h.before, h.after]) {
    snapshot.ledger.push(row)
    snapshot.ledger.sort(
      (a, b) => a.migration_name.localeCompare(b.migration_name) || a.id.localeCompare(b.id),
    )
    snapshot.physicalLedgerCount++
    snapshot.physicalLedgerHash = hashJson(
      snapshot.ledger.map(({ id, rowHash }) => ({ id, rowHash })),
    )
  }
  h.evidence.historicalRollbackRows = [{ id: row.id, rowHash: row.rowHash }]
  h.evidence.restoredPhysicalLedgerHash = h.before.physicalLedgerHash
  h.evidence.rehearsedPhysicalLedgerCount++
  await h.run()
  h.evidence.historicalRollbackRows = []
  await assert.rejects(
    runRelease269({ ...h.options, readSnapshot: async () => h.before }),
    /rollback-history-mismatch/u,
  )
})

test('RLS, existing ownership/grants, sequences and new-function privileges cannot drift', async () => {
  for (const mutate of [
    (h) => {
      h.after.policyHash = digest('changed RLS')
    },
    (h) => {
      h.after.sequenceStateHash = digest('changed sequence')
    },
    (h) => {
      h.after.security[0].hash = digest('changed owner')
      h.after.securityHash = hashJson(h.after.security)
    },
    (h) => {
      h.after.newFunctionPrivilegesHash = digest('extra grant')
    },
    (h) => {
      h.after.security.push({ identity: 'relation:unreviewed', hash: digest('new table') })
      h.after.securityHash = hashJson(h.after.security)
    },
  ]) {
    const h = harness()
    mutate(h)
    await assert.rejects(h.run())
    assert.ok(!h.events.includes('verified'))
  }
  for (const patch of [
    { archiveRetainsOwnershipAndPrivileges: false },
    { restoreOwnershipAclRemappingSha256: undefined },
    { rehearsedOriginalSecurityPreserved: false },
  ]) {
    const h = harness()
    Object.assign(h.evidence, patch)
    await assert.rejects(h.run())
    assert.ok(!h.events.includes('deploy'))
  }
})

test('complete269 code-only startup requires closed opt-in; an explicit hold still exits2', async () => {
  for (const hold of ['0', '1']) {
    const h = harness('staging')
    h.environment.PATHFINDER_STAGING_MIGRATION_ONLY_HOLD = hold
    h.environment.PATHFINDER_ALLOW_STAGING_MIGRATIONS = '0'
    h.options.readSnapshot = async () => h.after
    if (hold === '1')
      await assert.rejects(
        h.run(),
        (error) => stagingPredeployExitClassification(error).exitCode === 2,
      )
    else assert.deepEqual(await h.run(), { state: 'complete269', changed: false })
    assert.ok(!h.events.includes('deploy'))
  }
  const h = harness('staging')
  h.environment.PATHFINDER_STAGING_MIGRATION_ONLY_HOLD = '0'
  h.options.readSnapshot = async () => h.after
  await assert.rejects(h.run(), /opt-in explicitly closed/u)
})

test('readback SQL hashes original full rows and counts missing or changed current PUBLIC EVENT heads', () => {
  assert.match(AFFECTED_EVENT_ROWS_SQL, /LEFT JOIN public.event_content/u)
  assert.match(AFFECTED_EVENT_ROWS_SQL, /e.revision_id IS NULL OR k.id IS NULL/u)
  assert.match(AFFECTED_EVENT_ROWS_SQL, /content_publication_id IS DISTINCT FROM p.id/u)
  assert.match(AFFECTED_EVENT_ROWS_SQL, /newer.event_order>p.event_order/u)
  assert.match(
    tableHashSql('content_versions', ['id', 'created_at', 'snapshot']),
    /"created_at", "snapshot"/u,
  )
  assert.throws(() => tableHashSql('x; DROP TABLE y', ['id']))
  assert.throws(() => tableHashSql('safe', ['id; SELECT 1']))
})

test('already269 startup allows legitimate later fact applicability and does not rerun backfill gates', async () => {
  const h = harness('staging')
  h.environment.PATHFINDER_STAGING_MIGRATION_ONLY_HOLD = '0'
  h.environment.PATHFINDER_ALLOW_STAGING_MIGRATIONS = '0'
  h.after.applicabilityDefaultsValid = false
  h.after.affectedEventRows = 1
  h.after.otherClientSessions = 4
  h.evidence.backupCreatedAt = iso(-200_000_000)
  h.options.readSnapshot = async () => h.after
  assert.deepEqual(await h.run(), { state: 'complete269', changed: false })
  assert.ok(!h.events.includes('deploy'))
})

test('staging image includes the new runner dependency closure and leaves historical runner in place', async () => {
  const docker = await readFile(new URL('../Dockerfile.web.staging', import.meta.url), 'utf8')
  for (const name of [
    'run-release269-migration.mjs',
    'run-staging-migration-predeploy.mjs',
    'release269-runtime-admission.mjs',
    'release269-readback.mjs',
    'release269-logical-schema.mjs',
    'release269-queue-readback.mjs',
    'release269-migration-contract.mjs',
    'production-migration-admission.mjs',
    'staging-migration-admission.mjs',
    'operator-cli-failure.mjs',
  ])
    assert.ok(docker.includes(name))
  assert.ok(docker.includes(RELEASE269_APPROVAL))
  assert.ok(docker.includes('pnpm --filter @pathfinder/jobs --prod deploy /migration-jobs'))
  assert.ok(
    docker.includes('COPY --from=builder --chown=node:node /migration-jobs /migration-jobs'),
  )
  const builder = docker.slice(
    docker.indexOf('FROM base AS builder'),
    docker.indexOf('FROM base AS runner'),
  )
  const runner = docker.slice(docker.indexOf('FROM base AS runner'))
  assert.ok(builder.includes('ENV NODE_OPTIONS=--max-old-space-size=6144'))
  assert.ok(!runner.includes('NODE_OPTIONS'))
})

test('each client read refreshes its connection statistics snapshot before observing sessions', async () => {
  const calls = []
  let generation = 0
  const query = async (sql) => {
    calls.push(sql)
    if (sql === 'SELECT pg_stat_clear_snapshot() IS NULL AS ignored') {
      generation += 1
      return [{ ignored: false }]
    }
    assert.match(sql, /FROM pg_stat_activity/u)
    return generation === 1
      ? []
      : [{ role: 'postgres', application: 'application', state: 'idle', hasTransaction: false }]
  }
  assert.equal((await readRelease269Clients(query)).otherClientSessions, 0)
  assert.equal((await readRelease269Clients(query)).blockingClientSessions, 1)
  assert.equal(calls.length, 4)
  assert.equal(calls[0], calls[2])
})

test('only observed role/application provider pairs are exempt while idle and transaction-free', async () => {
  const rows = [
    ['supabase_admin', ''],
    ['supabase_admin', 'postgres_exporter'],
    ['authenticator', 'PostgREST'],
    ['postgres', 'Supavisor'],
    ['pgbouncer', 'supavisor tenant-pool'],
  ].map(([role, application]) => ({ role, application, state: 'idle', hasTransaction: false }))
  const clients = summarizeRelease269Clients(rows)
  assert.equal(clients.approvedIdleProviderClientSessions, rows.length)
  assert.equal(clients.blockingClientSessions, 0)
  const h = harness()
  Object.assign(h.before, clients)
  await h.run()
  for (const patch of [
    { state: 'active' },
    { hasTransaction: true },
    { state: null },
    { hasTransaction: undefined },
    { role: 'application-role' },
    { application: 'unclassified' },
    { role: 'postgres', application: 'PostgREST' },
  ]) {
    for (const row of rows) {
      const summary = summarizeRelease269Clients([{ ...row, ...patch }])
      assert.equal(summary.blockingClientSessions, 1)
      const f = harness()
      Object.assign(f.before, summary)
      await assert.rejects(f.run())
      assert.ok(!f.events.includes('deploy'))
    }
  }
  const staging = harness('staging')
  Object.assign(staging.before, clients)
  await assert.rejects(staging.run(), /clients-remain/u)
  for (const field of [
    'approvedIdleProviderClientSessions',
    'blockingClientSessions',
    'activeOrTransactionalClientSessions',
  ]) {
    const f = harness()
    delete f.before[field]
    await assert.rejects(f.run(), /client-proof-required/u)
  }
})
