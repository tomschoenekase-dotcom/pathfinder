import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import {
  RELEASE270_CATALOG_SCHEMA,
  assertRelease270Catalog,
  assertRelease270CatalogShape,
  release270CatalogHash,
  readRelease270Catalog,
} from './lib/release270-catalog-contract.mjs'

// Synthetic contract fixture, not PostgreSQL replay evidence or an approved seal.
const functions = []
for (const migration of [
  '20261022001000_deterministic_event_search_projection',
  '20261023001000_add_fact_applicability',
]) {
  const sql = (
    await readFile(
      new URL(`../packages/db/prisma/migrations/${migration}/migration.sql`, import.meta.url),
      'utf8',
    )
  ).replace(/\r\n/gu, '\n')
  for (const match of sql.matchAll(
    /CREATE (?:OR REPLACE )?FUNCTION ([a-z_0-9]+)\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu,
  )) {
    functions.push({
      proname: match[1],
      arguments: '',
      source: match[2],
      security_definer: false,
      definition: match[0],
    })
  }
}
const fixture = () => {
  const tables = [
    'embedding_venue_refreshes',
    'embedding_venue_refresh_records',
    ...Array.from({ length: 297 }, (_, i) => `fictional_table_${i}`),
  ]
  const constraints = Object.entries({
    embedding_venue_refreshes: ['pkey', 'max_records_check', 'tenant_id_fkey', 'venue_id_fkey'],
    embedding_venue_refresh_records: ['pkey', 'ordinal_check', 'entity_type_check', 'scope_fkey'],
    operational_fact: ['applicability_shape_check'],
  }).flatMap(([table, names]) =>
    names.map((name) => ({
      relname: table === 'operational_fact' ? 'operational_fact_content' : table,
      conname: `${table}_${name}`,
      contype: name.endsWith('fkey') ? 'f' : name === 'pkey' ? 'p' : 'c',
      convalidated: true,
      delete_action: name.endsWith('fkey') ? 'r' : ' ',
      update_action: name.endsWith('fkey') ? 'c' : ' ',
      definition: `fictional exact definition ${table}_${name}`,
    })),
  )
  return {
    schema: RELEASE270_CATALOG_SCHEMA,
    tables: tables.map((tablename) => ({ tablename })),
    columns: [
      'applicability_scope',
      'applicability_subject_module_ids',
      'applicability_place_ids',
    ].map((column_name, index) => ({
      table_name: 'operational_fact_content',
      column_name,
      udt_name: index === 0 ? 'text' : '_text',
      formatted_type: index === 0 ? 'text' : 'text[]',
      atttypmod: -1,
      is_nullable: index === 0 ? 'YES' : 'NO',
      column_default: index === 0 ? null : "'{}'::text[]",
    })),
    enums: Object.entries({
      EmbeddingVenueRefreshStatus: ['QUEUED', 'RUNNING', 'COMPLETE', 'STOPPED', 'OUTCOME_UNKNOWN'],
      EmbeddingVenueRefreshRecordStatus: [
        'PENDING',
        'RUNNING',
        'COMPLETE',
        'FAILED',
        'OUTCOME_UNKNOWN',
      ],
    }).flatMap(([typname, labels]) =>
      labels.map((enumlabel, index) => ({ typname, enumlabel, enumsortorder: index + 1 })),
    ),
    constraints,
    indexes: [
      'embedding_venue_refreshes_operation_key_key',
      'embedding_venue_refreshes_tenant_id_venue_id_id_key',
      'embedding_venue_refreshes_tenant_id_venue_id_created_at_idx',
      'embedding_venue_refreshes_active_venue_key',
      'embedding_venue_refresh_records_refresh_id_ordinal_key',
      'embedding_venue_refresh_records_refresh_id_entity_type_entity_i',
      'embedding_venue_refresh_records_tenant_id_venue_id_refresh_id_i',
    ].map((relname) => ({
      relname,
      indisvalid: true,
      definition: `fictional exact index ${relname}`,
    })),
    functions: structuredClone(functions),
    triggers: [
      {
        relname: 'fictional_table_1',
        tgname: 'immutable_guard',
        enabled: 'O',
        definition: 'fictional append-only guard',
      },
    ],
  }
}

test('catalog requires an independently supplied exact reference seal; never grants hosted authority', () => {
  const reference = fixture()
  assertRelease270CatalogShape(reference)
  assert.throws(() => assertRelease270Catalog(reference), /reviewed-reference-required/u)
  const referenceHash = release270CatalogHash(reference)
  assert.deepEqual(
    assertRelease270Catalog(structuredClone(reference), { reference, referenceHash }),
    { catalogHash: referenceHash, hostedApplicationAuthorized: false },
  )
  assert.throws(
    () => assertRelease270Catalog(reference, { reference, referenceHash: '0'.repeat(64) }),
    /reference-seal/u,
  )
})

test('CHECK, FK, index predicate, default, function and trigger drift fail exact catalog comparison', () => {
  const reference = fixture()
  const seal = { reference, referenceHash: release270CatalogHash(reference) }
  for (const group of ['constraints', 'indexes', 'functions', 'triggers']) {
    const changed = structuredClone(reference)
    changed[group][0].definition += ' weakened'
    assert.throws(() => assertRelease270Catalog(changed, seal), /catalog-drift/u)
  }
  const changed = structuredClone(reference)
  changed.columns[1].column_default = "'{unexpected}'::text[]"
  assert.throws(() => assertRelease270Catalog(changed, seal))
})

test('structural invariants refuse even a matching but weakened reference', () => {
  for (const mutate of [
    (c) => c.tables.pop(),
    (c) => {
      c.enums[0].enumsortorder = 6
    },
    (c) => {
      c.enums[0].enumlabel = 'UNKNOWN'
    },
    (c) => {
      c.functions[0].source += '\n-- changed'
    },
    (c) => {
      c.functions[0].security_definer = true
    },
    (c) => c.functions.push(c.functions[0]),
    (c) => {
      c.constraints[0].convalidated = false
    },
    (c) => {
      c.constraints.find((r) => r.contype === 'f').delete_action = 'c'
    },
    (c) => {
      c.indexes[0].indisvalid = false
    },
    (c) => c.indexes.pop(),
  ]) {
    const reference = fixture()
    mutate(reference)
    assert.throws(() =>
      assertRelease270Catalog(reference, {
        reference,
        referenceHash: release270CatalogHash(reference),
      }),
    )
  }
})

test('catalog canonicalization accepts row/key order only; duplicates and missing groups fail', () => {
  const reference = fixture()
  const changed = structuredClone(reference)
  changed.tables.reverse()
  changed.columns = changed.columns.map((row) => Object.fromEntries(Object.entries(row).reverse()))
  assert.equal(release270CatalogHash(reference), release270CatalogHash(changed))
  assertRelease270Catalog(changed, { reference, referenceHash: release270CatalogHash(reference) })
  changed.tables[0] = changed.tables[1]
  assert.throws(() => assertRelease270CatalogShape(changed), /duplicate-tables/u)
  delete changed.triggers
  assert.throws(() => release270CatalogHash(changed), /triggers-required/u)
})

test('reader only issues bounded public-catalog SELECTs through supplied adapter', async () => {
  const queries = []
  const result = await readRelease270Catalog(async (sql) => {
    queries.push(sql)
    return []
  })
  assert.equal(queries.length, 7)
  for (const sql of queries) {
    assert.match(sql, /^SELECT /u)
    assert.match(sql, /'public'/u)
    assert.doesNotMatch(sql, /INSERT|UPDATE |DELETE |ALTER |DROP /u)
  }
  assert.equal(result.schema, RELEASE270_CATALOG_SCHEMA)
  assert.throws(() => assertRelease270CatalogShape(result), /table-count/u)
})

test('disabled trigger and narrowed column cannot match the reviewed catalog', () => {
  const reference = fixture()
  const seal = { reference, referenceHash: release270CatalogHash(reference) }
  const disabled = structuredClone(reference)
  disabled.triggers[0].enabled = 'D'
  assert.throws(() => assertRelease270Catalog(disabled, seal), /disabled-trigger/u)
  const narrowed = structuredClone(reference)
  narrowed.columns[0].formatted_type = 'character varying(4)'
  narrowed.columns[0].atttypmod = 8
  assert.throws(() => assertRelease270Catalog(narrowed, seal), /catalog-drift/u)
})

test('all migration270 index identifiers are checked using PostgreSQL63-byte names', async () => {
  const sql = await readFile(
    new URL(
      '../packages/db/prisma/migrations/20261029120000_venue_embedding_refresh/migration.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const names = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)"/gu)].map((match) =>
    match[1].slice(0, 63),
  )
  const observed = fixture().indexes.map((row) => row.relname)
  assert.deepEqual(observed.sort(), names.sort())
})
