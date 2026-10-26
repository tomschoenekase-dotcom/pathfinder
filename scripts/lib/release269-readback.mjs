// Read-only, aggregate-only preservation evidence. No venue text or credentials
// leave PostgreSQL. Whole-row hashes include timestamps, vectors and receipts.
import assert from 'node:assert/strict'
import { RELEASE269 } from './release269-migration-contract.mjs'
import { RELEASE269_PROOF_SCHEMA, hashJson } from './release269-runtime-admission.mjs'
import { VERIFIED_BASELINE_CHECKSUMS } from '../run-staging-migration-predeploy.mjs'

export const APPLICABILITY_COLUMNS = Object.freeze([
  'applicability_scope',
  'applicability_subject_module_ids',
  'applicability_place_ids',
])
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0)
const ordered = (rows) =>
  [...rows].sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)))

// This is the exact migration selection and early-return predicate. Missing or
// stale linked projections count as affected too. No row rewrite is admitted.
export const AFFECTED_EVENT_ROWS_SQL = `
SELECT count(*)::int AS count
FROM public.content_module_publications p
JOIN public.content_module_revisions r ON r.id=p.revision_id AND r.tenant_id=p.tenant_id
 AND r.venue_id=p.venue_id AND r.module_id=p.module_id AND r.kind=p.module_kind
LEFT JOIN public.event_content e ON e.revision_id=r.id
LEFT JOIN public.venue_knowledge_entries k ON k.tenant_id=p.tenant_id AND k.venue_id=p.venue_id
 AND k.content_module_id=p.module_id
WHERE p.module_kind='EVENT' AND p.action='PUBLISH' AND r.audience='PUBLIC'
 AND NOT EXISTS (SELECT 1 FROM public.content_module_publications newer
 WHERE newer.tenant_id=p.tenant_id AND newer.venue_id=p.venue_id
 AND newer.module_id=p.module_id AND newer.event_order>p.event_order)
 AND (e.revision_id IS NULL OR k.id IS NULL OR k.content_publication_id IS DISTINCT FROM p.id OR k.content IS DISTINCT FROM
 concat_ws(E'\\n', e.description, 'Starts: ' || to_char(e.starts_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'Ends: ' || coalesce(to_char(e.ends_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'not specified')))`

const quoteIdentifier = (value) => {
  assert.match(value, /^[a-zA-Z_][a-zA-Z0-9_]*$/u, 'release269-unsafe-identifier')
  return `"${value}"`
}
export function tableHashSql(name, columns) {
  const relation = quoteIdentifier(name)
  assert.ok(columns.length > 0)
  const selected = columns.map(quoteIdentifier).join(', ')
  return `SELECT count(*)::text AS count,
  encode(sha256(convert_to(coalesce(string_agg(row_hash,E'\\n' ORDER BY row_hash),''),'UTF8')),'hex') AS hash
  FROM (SELECT encode(sha256(convert_to(row_to_json(original)::text,'UTF8')),'hex') AS row_hash
  FROM (SELECT ${selected} FROM public.${relation}) original) hashes`
}

async function snapshotInside(database, scope) {
  await database.$executeRawUnsafe('SET TRANSACTION READ ONLY')
  await database.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
  await database.$executeRawUnsafe("SET LOCAL DateStyle = 'ISO, YMD'")
  const query = (sql) => database.$queryRawUnsafe(sql)
  const [{ count: otherClientSessions }] =
    await query(`SELECT count(*)::int AS count FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`)
  const ledger =
    await query(`SELECT id, migration_name, checksum, finished_at, rolled_back_at, logs,
    encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex') AS "rowHash"
    FROM public._prisma_migrations m ORDER BY migration_name,id`)
  // Error logs never leave this function. Their presence makes an active row
  // inadmissible, and the full private row remains covered by its digest.
  for (const row of ledger) {
    row.logs = row.logs === null || row.logs === '' ? row.logs : '[nonempty]'
    for (const key of ['finished_at', 'rolled_back_at']) {
      if (row[key] instanceof Date) row[key] = row[key].toISOString()
    }
  }
  ledger.sort(
    (left, right) =>
      compareText(left.migration_name, right.migration_name) || compareText(left.id, right.id),
  )
  const relations = await query(`SELECT tablename FROM pg_catalog.pg_tables
    WHERE schemaname='public' ORDER BY tablename`)
  const columns = await query(`SELECT table_name,column_name,ordinal_position,data_type,udt_name,
    is_nullable,column_default FROM information_schema.columns WHERE table_schema='public'
    ORDER BY table_name,ordinal_position`)
  const tables = []
  for (const { tablename } of relations) {
    if (tablename === '_prisma_migrations') continue
    const originalColumns = columns
      .filter(
        (column) =>
          column.table_name === tablename &&
          !(
            tablename === 'operational_fact_content' &&
            APPLICABILITY_COLUMNS.includes(column.column_name)
          ),
      )
      .map((column) => column.column_name)
    const [result] = await query(tableHashSql(tablename, originalColumns))
    tables.push({
      name: tablename,
      columns: originalColumns,
      count: result.count,
      hash: result.hash,
    })
  }
  tables.sort((left, right) => compareText(left.name, right.name))
  const constraints = await query(`SELECT c.conname,t.relname,c.contype,c.convalidated,
    pg_get_constraintdef(c.oid,true) AS definition FROM pg_constraint c
    JOIN pg_namespace n ON n.oid=c.connamespace LEFT JOIN pg_class t ON t.oid=c.conrelid
    WHERE n.nspname='public' ORDER BY t.relname,c.conname`)
  const indexes =
    await query(`SELECT c.relname,i.indisvalid,pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname`)
  const functions =
    await query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.proname,arguments`)
  const triggers =
    await query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid,true) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)
  const enums = await query(`SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_enum e
    JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder`)
  const [{ count: affectedEventRows }] = await query(AFFECTED_EVENT_ROWS_SQL)
  const policies = await query(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check
    FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`)
  const rowSecurity = await query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`)
  const views = await query(`SELECT viewname,definition FROM pg_views
    WHERE schemaname='public' ORDER BY viewname`)
  const sequences =
    await query(`SELECT sequencename,data_type::text,start_value::text,min_value::text,
    max_value::text,increment_by::text,cycle,cache_size::text,last_value::text
    FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`)
  const relationSecurity = await query(`SELECT 'relation:'||c.relname AS identity,
    pg_get_userbyid(c.relowner) AS owner,coalesce(c.relacl::text,'') AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname`)
  const functionSecurity =
    await query(`SELECT 'function:'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS identity,
    pg_get_userbyid(p.proowner) AS owner,coalesce(p.proacl::text,'') AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' ORDER BY identity`)
  const schemaSecurity = await query(`SELECT 'schema:public' AS identity,
    pg_get_userbyid(nspowner) AS owner,coalesce(nspacl::text,'') AS acl
    FROM pg_namespace WHERE nspname='public'`)
  const defaultSecurity = await query(`SELECT 'defaults:'||pg_get_userbyid(d.defaclrole)||':'||
    coalesce(n.nspname,'global')||':'||d.defaclobjtype::text AS identity,
    pg_get_userbyid(d.defaclrole) AS owner,d.defaclacl::text AS acl
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    WHERE n.nspname='public' OR d.defaclnamespace=0 ORDER BY identity`)
  const security = [...relationSecurity, ...functionSecurity, ...schemaSecurity, ...defaultSecurity]
    .map((row) => ({ identity: row.identity, hash: hashJson(row) }))
    .sort((a, b) => compareText(a.identity, b.identity))
  // Restore owners may be remapped. Normalize only the function owner in the
  // two new functions' ACLs; all other grantee roles remain explicit.
  const newFunctionPrivileges = await query(`SELECT p.proname,
    pg_get_function_identity_arguments(p.oid) AS arguments,
    CASE WHEN a.grantor=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END AS grantor,
    CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END AS grantee,
    a.privilege_type,a.is_grantable FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE n.nspname='public' AND p.proname IN ('universal_content_event_projection_v1','operational_fact_applicability_ids_valid')
    ORDER BY p.proname,arguments,grantor,grantee,a.privilege_type,a.is_grantable`)
  const applicability = columns.filter(
    (row) =>
      row.table_name === 'operational_fact_content' &&
      APPLICABILITY_COLUMNS.includes(row.column_name),
  )
  const shape = constraints.find(
    (row) => row.conname === 'operational_fact_applicability_shape_check',
  )
  let applicabilityDefaultsValid = false
  if (applicability.length === 3) {
    const [{ count }] =
      await query(`SELECT count(*)::int AS count FROM public.operational_fact_content
      WHERE applicability_scope IS NOT NULL OR applicability_subject_module_ids IS DISTINCT FROM '{}'::text[]
      OR applicability_place_ids IS DISTINCT FROM '{}'::text[]`)
    applicabilityDefaultsValid = count === 0
  }
  const appPlans = await query(`SELECT plan_tier,enabled FROM public.product_plan_capabilities
    WHERE capability='app-webview' ORDER BY plan_tier`)
  const weekly = ledger.find(
    (row) =>
      row.migration_name === '20260413120000_add_weekly_digest' && row.rolled_back_at === null,
  )
  let weeklyDigestFingerprintValid = true
  if (weekly?.checksum === VERIFIED_BASELINE_CHECKSUMS['20260413120000_add_weekly_digest']) {
    const names = columns
      .filter((row) => row.table_name === 'weekly_digests')
      .map((row) => row.column_name)
      .sort()
    weeklyDigestFingerprintValid =
      JSON.stringify(names) ===
        JSON.stringify(
          [
            'id',
            'tenant_id',
            'week_start',
            'week_end',
            'status',
            'session_count',
            'message_count',
            'insights',
            'generated_at',
            'created_at',
          ].sort(),
        ) &&
      enums
        .filter((row) => row.typname === 'WeeklyDigestStatus')
        .map((row) => row.enumlabel)
        .join(',') === 'PENDING,PROCESSING,COMPLETE,FAILED' &&
      ['weekly_digests_pkey', 'weekly_digests_tenant_id_fkey'].every((name) =>
        constraints.some((row) => row.conname === name && row.relname === 'weekly_digests'),
      ) &&
      ['weekly_digests_tenant_id_week_start_idx', 'weekly_digests_tenant_id_week_start_key'].every(
        (name) => indexes.some((row) => row.relname === name),
      )
  }
  const [{ count: finalOtherClients }] =
    await query(`SELECT count(*)::int AS count FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`)
  return {
    schema: RELEASE269_PROOF_SCHEMA,
    ...scope,
    manifestHash: RELEASE269.manifestHash,
    observedAt: new Date().toISOString(),
    otherClientSessions: Math.max(otherClientSessions, finalOtherClients),
    activeLedgerCount: ledger.filter((row) => row.rolled_back_at === null).length,
    physicalLedgerCount: ledger.length,
    ledger,
    physicalLedgerHash: hashJson(ledger.map(({ id, rowHash }) => ({ id, rowHash }))),
    publicTableCount: relations.length,
    tables,
    dataHash: hashJson(tables),
    schemaHash: hashJson({
      columns: ordered(columns),
      constraints: ordered(constraints),
      indexes: ordered(indexes),
      functions: ordered(functions),
      triggers: ordered(triggers),
      enums: ordered(enums),
      policies: ordered(
        policies.map((row) => ({ ...row, roles: [...row.roles].sort(compareText) })),
      ),
      rowSecurity: ordered(rowSecurity),
      views: ordered(views),
    }),
    policyHash: hashJson({
      policies: ordered(
        policies.map((row) => ({ ...row, roles: [...row.roles].sort(compareText) })),
      ),
      rowSecurity: ordered(rowSecurity),
    }),
    sequenceStateHash: hashJson(ordered(sequences)),
    security,
    securityHash: hashJson(security),
    newFunctionPrivilegesHash: hashJson(ordered(newFunctionPrivileges)),
    invalidIndexes: indexes.filter((row) => !row.indisvalid).length,
    unvalidatedConstraints: constraints.filter((row) => !row.convalidated).length,
    affectedEventRows,
    applicabilityColumnsPresent: applicability.length,
    applicabilityDefaultsValid,
    applicabilitySchemaValid:
      applicability.length === 3 &&
      shape?.convalidated === true &&
      applicability.find((row) => row.column_name === 'applicability_scope')?.is_nullable ===
        'YES' &&
      applicability
        .filter((row) => row.column_name !== 'applicability_scope')
        .every((row) => row.udt_name === '_text' && row.is_nullable === 'NO'),
    eventFunctionPresent: functions.some(
      (row) => row.proname === 'universal_content_event_projection_v1',
    ),
    weeklyDigestFingerprintValid,
    disabledAppPlansValid:
      JSON.stringify(appPlans) ===
      JSON.stringify([
        { plan_tier: 'free', enabled: false },
        { plan_tier: 'pro', enabled: false },
      ]),
  }
}

export async function readRelease269Snapshot(database, scope) {
  return database.$transaction((transaction) => snapshotInside(transaction, scope), {
    isolationLevel: 'RepeatableRead',
    maxWait: 10_000,
    timeout: 300_000,
  })
}
