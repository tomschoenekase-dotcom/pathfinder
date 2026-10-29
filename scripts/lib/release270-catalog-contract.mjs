// Offline evidence contract, not database connection or hosted execution admission.
// The reference hash must come from an independently reviewed fresh PostgreSQL16
// replay. Computing that hash from the observed database is not independent proof.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assertRelease270Ledger, RELEASE270 } from './release270-migration-contract.mjs'

export const RELEASE270_CATALOG_SCHEMA = 'torchiko-release270-catalog/v1'
const digest = (text) => createHash('sha256').update(text).digest('hex')
const groups = ['tables', 'columns', 'enums', 'constraints', 'indexes', 'functions', 'triggers']
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value
const canonical = (catalog) =>
  Object.fromEntries(
    groups.map((group) => {
      assert.ok(Array.isArray(catalog[group]), `release270-catalog-${group}-required`)
      return [group, catalog[group].map((row) => JSON.stringify(stable(row))).sort()]
    }),
  )
export const release270CatalogHash = (catalog) => digest(JSON.stringify(canonical(catalog)))

export const RELEASE270_FUNCTION_BODIES = Object.freeze({
  universal_content_event_projection_v1:
    'a6e5b9f27f2a0f006e8cd5b46727970feb0d31ebf829e9b06352960eb2628eb9',
  sync_universal_content_search_projection:
    'a9c2a261fac55a586254ead4fccec713544848334e0e8fd8d7108f30f357c4f7',
  guard_universal_content_search_projection:
    'a14abcd691ed1f7ee1c7500201814d4d3ae1b41ac7306054f08937dbb124a93f',
  operational_fact_applicability_ids_valid:
    'a01b1274d34e4a52a139f70e6d345dadd9bc58d56e1e7d88ae975cdfdca98169',
})
const enums = {
  EmbeddingVenueRefreshStatus: ['QUEUED', 'RUNNING', 'COMPLETE', 'STOPPED', 'OUTCOME_UNKNOWN'],
  EmbeddingVenueRefreshRecordStatus: [
    'PENDING',
    'RUNNING',
    'COMPLETE',
    'FAILED',
    'OUTCOME_UNKNOWN',
  ],
}
const requiredConstraints = {
  embedding_venue_refreshes: [
    'embedding_venue_refreshes_pkey',
    'embedding_venue_refreshes_max_records_check',
    'embedding_venue_refreshes_tenant_id_fkey',
    'embedding_venue_refreshes_venue_id_fkey',
  ],
  embedding_venue_refresh_records: [
    'embedding_venue_refresh_records_pkey',
    'embedding_venue_refresh_records_ordinal_check',
    'embedding_venue_refresh_records_entity_type_check',
    'embedding_venue_refresh_records_scope_fkey',
  ],
}
const requiredIndexes = [
  'embedding_venue_refreshes_operation_key_key',
  'embedding_venue_refreshes_tenant_id_venue_id_id_key',
  'embedding_venue_refreshes_tenant_id_venue_id_created_at_idx',
  'embedding_venue_refreshes_active_venue_key',
  'embedding_venue_refresh_records_refresh_id_ordinal_key',
  // PostgreSQL truncates identifiers to NAMEDATALEN-1 (63 bytes).
  'embedding_venue_refresh_records_refresh_id_entity_type_entity_i',
  'embedding_venue_refresh_records_tenant_id_venue_id_refresh_id_idx',
]

export function assertRelease270CatalogShape(catalog) {
  assert.equal(catalog.schema, RELEASE270_CATALOG_SCHEMA)
  canonical(catalog)
  const identities = {
    tables: ['tablename'],
    columns: ['table_name', 'column_name'],
    enums: ['typname', 'enumlabel'],
    constraints: ['relname', 'conname'],
    indexes: ['relname'],
    functions: ['proname', 'arguments'],
    triggers: ['relname', 'tgname'],
  }
  for (const [group, keys] of Object.entries(identities)) {
    const ids = catalog[group].map((row) => {
      for (const key of keys)
        assert.equal(typeof row[key], 'string', `release270-${group}-identity`)
      return JSON.stringify(keys.map((key) => row[key]))
    })
    assert.equal(new Set(ids).size, ids.length, `release270-duplicate-${group}`)
  }
  for (const row of catalog.columns) {
    assert.equal(typeof row.formatted_type, 'string', 'release270-column-type-required')
    assert.ok(Number.isInteger(row.atttypmod), 'release270-column-typmod-required')
  }
  for (const row of catalog.triggers) assert.equal(row.enabled, 'O', 'release270-disabled-trigger')
  assert.equal(catalog.tables.length, RELEASE270.publicTableCount, 'release270-table-count')
  for (const table of Object.keys(requiredConstraints))
    assert.ok(catalog.tables.some((row) => row.tablename === table))
  for (const [name, labels] of Object.entries(enums)) {
    const rows = catalog.enums
      .filter((row) => row.typname === name)
      .sort((a, b) => a.enumsortorder - b.enumsortorder)
    assert.deepEqual(
      rows.map((row) => row.enumlabel),
      labels,
      'release270-enum-order',
    )
    assert.deepEqual(
      rows.map((row) => row.enumsortorder),
      [1, 2, 3, 4, 5],
      'release270-enum-positions',
    )
  }
  for (const name of [
    'applicability_scope',
    'applicability_subject_module_ids',
    'applicability_place_ids',
  ]) {
    const column = catalog.columns.find(
      (row) => row.table_name === 'operational_fact_content' && row.column_name === name,
    )
    assert.ok(column, 'release270-applicability-column')
    const scope = name === 'applicability_scope'
    assert.equal(column.udt_name, scope ? 'text' : '_text')
    assert.equal(column.is_nullable, scope ? 'YES' : 'NO')
    assert.equal(column.column_default, scope ? null : "'{}'::text[]")
  }
  for (const [name, bodyHash] of Object.entries(RELEASE270_FUNCTION_BODIES)) {
    const functions = catalog.functions.filter((row) => row.proname === name)
    assert.equal(functions.length, 1, 'release270-function-overload-or-missing')
    assert.equal(
      digest(functions[0].source.replace(/\r\n/gu, '\n')),
      bodyHash,
      'release270-function-body',
    )
    assert.equal(functions[0].security_definer, false, 'release270-function-security')
  }
  assert.ok(
    catalog.constraints.some(
      (row) =>
        row.relname === 'operational_fact_content' &&
        row.conname === 'operational_fact_applicability_shape_check',
    ),
  )
  for (const [table, names] of Object.entries(requiredConstraints)) {
    assert.deepEqual(
      catalog.constraints
        .filter((row) => row.relname === table)
        .map((row) => row.conname)
        .sort(),
      [...names].sort(),
      'release270-refresh-constraints',
    )
  }
  for (const row of catalog.constraints)
    assert.equal(row.convalidated, true, 'release270-unvalidated-constraint')
  for (const row of catalog.constraints.filter(
    (row) => Object.hasOwn(requiredConstraints, row.relname) && row.contype === 'f',
  )) {
    assert.equal(row.delete_action, 'r', 'release270-fk-delete')
    assert.equal(row.update_action, 'c', 'release270-fk-update')
  }
  assert.equal(
    catalog.constraints.filter(
      (row) => Object.hasOwn(requiredConstraints, row.relname) && row.contype === 'f',
    ).length,
    3,
  )
  for (const row of catalog.indexes) assert.equal(row.indisvalid, true, 'release270-invalid-index')
  for (const name of requiredIndexes)
    assert.ok(
      catalog.indexes.some((row) => row.relname === name),
      `release270-index-missing:${name}`,
    )
  return catalog
}

export function assertRelease270Catalog(catalog, { reference, referenceHash } = {}) {
  assert.match(referenceHash ?? '', /^[a-f0-9]{64}$/u, 'release270-reviewed-reference-required')
  assertRelease270CatalogShape(reference)
  assert.equal(release270CatalogHash(reference), referenceHash, 'release270-reference-seal')
  assertRelease270CatalogShape(catalog)
  // Exact PG16 definitions cover CHECK semantics, index predicates, uniqueness,
  // defaults, FK targets/column order/actions, function attributes and triggers.
  assert.deepEqual(canonical(catalog), canonical(reference), 'release270-catalog-drift')
  return { catalogHash: referenceHash, hostedApplicationAuthorized: false }
}

export function assertRelease270Evidence({ ledger, catalog }, manifest, reference) {
  const state = assertRelease270Ledger(ledger, manifest)
  assert.equal(state.state, 'complete270', 'release270-complete-ledger-required')
  return { ...state, ...assertRelease270Catalog(catalog, reference) }
}

// Query adapter supplied by a separately admitted caller; this module never opens
// a connection or reads environment variables. Use a read-only repeatable snapshot.
export async function readRelease270Catalog(query) {
  const catalog = { schema: RELEASE270_CATALOG_SCHEMA }
  const statements = {
    tables: "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    columns:
      "SELECT c.table_name,c.column_name,c.ordinal_position,c.data_type,c.udt_name,c.is_nullable,c.column_default,format_type(a.atttypid,a.atttypmod) AS formatted_type,a.atttypmod FROM information_schema.columns c JOIN pg_namespace n ON n.nspname=c.table_schema JOIN pg_class t ON t.relnamespace=n.oid AND t.relname=c.table_name JOIN pg_attribute a ON a.attrelid=t.oid AND a.attname=c.column_name WHERE c.table_schema='public' ORDER BY c.table_name,c.ordinal_position",
    enums:
      "SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder",
    constraints:
      "SELECT t.relname,c.conname,c.contype,c.convalidated,c.confdeltype::text AS delete_action,c.confupdtype::text AS update_action,pg_get_constraintdef(c.oid,true) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace LEFT JOIN pg_class t ON t.oid=c.conrelid WHERE n.nspname='public' ORDER BY t.relname,c.conname",
    indexes:
      "SELECT c.relname,i.indisvalid,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname",
    functions:
      "SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,p.prosrc AS source,p.prosecdef AS security_definer,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.proname,arguments",
    triggers:
      "SELECT c.relname,t.tgname,t.tgenabled::text AS enabled,pg_get_triggerdef(t.oid,true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname",
  }
  for (const [key, sql] of Object.entries(statements)) catalog[key] = await query(sql)
  return catalog
}
