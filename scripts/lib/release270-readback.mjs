// Aggregates only. All ordinary table columns (including applicability and
// vectors) are hashed; complete physical ledger rows retain native timestamp text.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { tableHashSql, summarizeRelease269Clients } from './release269-readback.mjs'
import { readRelease270Catalog } from './release270-catalog-contract.mjs'
import { assertPreservedQueueProof } from './release269-queue-preservation.mjs'
import { RELEASE270_STAGING_QUEUE_RESOURCE } from './release270-staging-admission.mjs'
import { collectRelease270ConsumerObservation } from './release270-consumer-evidence.mjs'

export const hashRelease270 = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const refreshTables = ['embedding_venue_refresh_records', 'embedding_venue_refreshes']
export function assertRelease270ConsumerEvidence(
  evidence,
  { releaseSha, expectedHash, now = Date.now() },
) {
  assert.equal(evidence?.schema, 'torchiko-release270-consumer-inventory/v1')
  assert.equal(evidence.releaseSha, releaseSha)
  assert.equal(evidence.resource, RELEASE270_STAGING_QUEUE_RESOURCE)
  assert.equal(evidence.coverage, 'all-staging-deployed-consumers')
  assert.equal(evidence.unexpectedConsumers, 0)
  assert.equal(evidence.consumersHeld, true)
  assert.match(expectedHash ?? '', /^[a-f0-9]{64}$/u)
  const observed = Date.parse(evidence.observedAt)
  assert.ok(
    Number.isFinite(observed) && observed <= now && now - observed <= 60_000,
    'release270-consumer-evidence-stale',
  )
  assert.ok(
    Array.isArray(evidence.inventory) && evidence.inventory.length > 0,
    'release270-consumer-inventory-required',
  )
  assert.equal(
    new Set(evidence.inventory.map((row) => row.serviceId)).size,
    evidence.inventory.length,
  )
  for (const row of evidence.inventory) {
    assert.ok(typeof row.serviceId === 'string' && row.serviceId.length > 0)
    assert.equal(row.consumersHeld, true)
    assert.ok(
      row.workerFlags && typeof row.workerFlags === 'object' && !Array.isArray(row.workerFlags),
    )
    assert.ok(Object.keys(row.workerFlags).length > 0)
    for (const value of Object.values(row.workerFlags))
      assert.ok(['0', '1', 'true', 'false'].includes(value))
  }
  const { observedAt, ...sealed } = evidence
  assert.equal(hashRelease270(sealed), expectedHash, 'release270-consumer-evidence-seal')
  return {
    consumerInventoryHash: expectedHash,
    unexpectedConsumers: 0,
    workerFlagsHash: hashRelease270(
      evidence.inventory.map(({ serviceId, workerFlags }) => ({ serviceId, workerFlags })),
    ),
  }
}

export async function readRelease270Snapshot({
  database,
  releaseSha,
  databaseResource,
  lockPid,
  readQueues,
  readConsumers,
  trustedConsumerInventoryHash,
  trustedConsumerCollectorHash,
  recordConsumerObservation,
  now = Date.now,
}) {
  const started = now()
  assert.match(
    trustedConsumerCollectorHash ?? '',
    /^[a-f0-9]{64}$/u,
    'release270-trusted-collector-required',
  )
  assert.ok(lockPid === undefined || (Number.isSafeInteger(lockPid) && lockPid > 0))
  const snapshot = await database.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
      await tx.$executeRawUnsafe("SET LOCAL DateStyle = 'ISO, YMD'")
      const query = (sql) => tx.$queryRawUnsafe(sql)
      const [server] = await query(
        `SELECT current_setting('server_version_num')::int AS "serverVersionNum"`,
      )
      assert.ok(
        Number.isInteger(server?.serverVersionNum) && server.serverVersionNum >= 100000,
        'release270-postgres-version-required',
      )
      const postgresMajor = Math.floor(server.serverVersionNum / 10000)
      const clients = async () => {
        await query('SELECT pg_stat_clear_snapshot() IS NULL AS ignored')
        return summarizeRelease269Clients(
          await query(
            `SELECT usename AS role, application_name AS application, state, xact_start IS NOT NULL AS "hasTransaction" FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() ${lockPid ? `AND pid<>${lockPid}` : ''} AND backend_type='client backend'`,
          ),
        )
      }
      const initial = await clients()
      const catalog = await readRelease270Catalog(query)
      const physical = await query(
        `SELECT to_jsonb(m) AS row, encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex') AS "rowHash" FROM public._prisma_migrations m ORDER BY migration_name,id`,
      )
      const ledger = physical.map(({ row, rowHash }) => ({
        ...row,
        logs: row.logs === null || row.logs === '' ? row.logs : '[nonempty]',
        rowHash,
      }))
      const tables = []
      for (const { tablename } of catalog.tables) {
        if (tablename === '_prisma_migrations') continue
        const columns = catalog.columns
          .filter((row) => row.table_name === tablename)
          .map((row) => row.column_name)
        const [result] = await query(tableHashSql(tablename, columns))
        tables.push({ name: tablename, columns, count: result.count, hash: result.hash })
      }
      const policies = await query(
        "SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname",
      )
      const rowSecurity = await query(
        "SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname",
      )
      const sequences = await query(
        "SELECT sequencename,data_type::text,start_value::text,min_value::text,max_value::text,increment_by::text,cycle,cache_size::text,last_value::text FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename",
      )
      const security = await query(
        `SELECT 'relation:'||c.relname AS identity,pg_get_userbyid(c.relowner) AS owner,coalesce(c.relacl::text,'') AS acl,coalesce(t.relname,c.relname) AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_class t ON t.oid=i.indrelid WHERE n.nspname='public' ORDER BY c.relname`,
      )
      // Column grants are independent of relation ACLs. Keep NULL distinct from
      // an explicitly empty ACL and bind the owning table's identity/kind/owner.
      const columnSecurity = await query(
        "SELECT c.relname AS table_name,a.attname AS column_name,c.relkind::text AS kind,pg_get_userbyid(c.relowner) AS owner,a.attacl::text AS acl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum",
      )
      const otherSecurity = await query(
        `SELECT 'function:'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS identity,pg_get_userbyid(p.proowner) AS owner,coalesce(p.proacl::text,'') AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' UNION ALL SELECT 'schema:public',pg_get_userbyid(nspowner),coalesce(nspacl::text,'') FROM pg_namespace WHERE nspname='public' UNION ALL SELECT 'defaults:'||pg_get_userbyid(d.defaclrole)||':'||coalesce(n.nspname,'global')||':'||d.defaclobjtype::text,pg_get_userbyid(d.defaclrole),d.defaclacl::text FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='public' OR d.defaclnamespace=0 ORDER BY identity`,
      )
      const typeSecurity = await query(
        "SELECT t.typname,pg_get_userbyid(t.typowner) AS owner,coalesce(t.typacl::text,'') AS acl,(coalesce(base.typname,t.typname) IN ('EmbeddingVenueRefreshStatus','EmbeddingVenueRefreshRecordStatus','embedding_venue_refreshes','embedding_venue_refresh_records')) AS is_new FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_type base ON base.oid=t.typelem WHERE n.nspname='public' ORDER BY t.typname",
      )
      const final = await clients()
      return {
        releaseSha,
        postgresMajor,
        databaseResource,
        ledger,
        publicTableCount: catalog.tables.length,
        catalog,
        tables,
        blockingClientSessions: Math.max(
          initial.blockingClientSessions,
          final.blockingClientSessions,
        ),
        activeOrTransactionalClientSessions: Math.max(
          initial.activeOrTransactionalClientSessions,
          final.activeOrTransactionalClientSessions,
        ),
        newSecurityHash: hashRelease270({
          security: security.filter((row) => refreshTables.includes(row.table_name)),
          columnSecurity: columnSecurity.filter((row) => refreshTables.includes(row.table_name)),
          typeSecurity: typeSecurity.filter((row) => row.is_new),
          policies: policies.filter((row) => refreshTables.includes(row.tablename)),
          rowSecurity: rowSecurity.filter((row) => refreshTables.includes(row.relname)),
        }),
        sequenceStateHash: hashRelease270(sequences),
        policyHash: hashRelease270({
          policies,
          rowSecurity: rowSecurity.filter((row) => !refreshTables.includes(row.relname)),
        }),
        existingSecurityHash: hashRelease270({
          security: security.filter((row) => !refreshTables.includes(row.table_name)),
          columnSecurity: columnSecurity.filter((row) => !refreshTables.includes(row.table_name)),
          otherSecurity,
          typeSecurity: typeSecurity.filter((row) => !row.is_new),
        }),
      }
    },
    { isolationLevel: 'RepeatableRead', timeout: 60_000, maxWait: 10_000 },
  )
  const queues = await readQueues()
  assertPreservedQueueProof(queues)
  assert.equal(queues.target, 'staging')
  assert.equal(queues.releaseSha, releaseSha)
  assert.equal(queues.resourceIdentity, RELEASE270_STAGING_QUEUE_RESOURCE)
  assert.equal(queues.active, 0)
  const { evidence: consumers, receipt } = await collectRelease270ConsumerObservation({
    readConsumers,
    releaseSha,
    resource: RELEASE270_STAGING_QUEUE_RESOURCE,
    trustedCollectorHash: trustedConsumerCollectorHash,
    now,
  })
  const inventory = assertRelease270ConsumerEvidence(consumers, {
    releaseSha,
    expectedHash: trustedConsumerInventoryHash,
    now: now(),
  })
  // Fresh challenge/provider metadata must not drift the stable policy cutoff.
  // A durable caller can journal it separately; driver/provider payloads are absent.
  if (recordConsumerObservation) await recordConsumerObservation(receipt)
  // Queue proof and independently recollected deployment inventory follow the
  // final database scan. Merely restamping an old inventory is not valid evidence.
  const observedAt = new Date(
    Math.min(started, Date.parse(queues.firstObservedAt), Date.parse(consumers.observedAt)),
  ).toISOString()
  assert.ok(now() - Date.parse(observedAt) <= 60_000, 'release270-readback-expired')
  return {
    ...snapshot,
    observedAt,
    queueResource: queues.resourceIdentity,
    activeQueueJobs: queues.active,
    queueHash: hashRelease270({
      registry: queues.registry,
      countsSha256: queues.countsSha256,
      jobsSha256: queues.jobsSha256,
      canonicalSha256: queues.canonicalSha256,
    }),
    ...inventory,
  }
}
