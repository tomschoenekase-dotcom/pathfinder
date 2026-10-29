import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DATABASE,
  PREVIOUS_APP,
  guardCompatibilityEnvironment,
  fixtureSql,
  assertUpgradePreservation,
  assertRetainedRows,
  assertHistoricalTests,
} from './lib/release270-compatibility.mjs'
import {
  readRelease270Catalog,
  release270CatalogHash,
  assertRelease270CatalogShape,
} from './lib/release270-catalog-contract.mjs'

const target = guardCompatibilityEnvironment(process.env)
const candidate = resolve(import.meta.dirname, '..')
const previous = resolve(process.argv[2] ?? '')
const output = resolve(process.argv[3] ?? '')
assert.ok(
  process.argv.length === 4,
  'usage: node scripts/release270-compatibility.mjs PREVIOUS_CHECKOUT NEW_ARTIFACT_DIR',
)
assert.notEqual(candidate, previous)
mkdirSync(output, { recursive: false })
// Allowlist prevents inherited provider, hosted database, PG service and Node overrides.
const env = Object.fromEntries(
  ['PATH', 'HOME', 'SYSTEMROOT', 'TEMP', 'TMP']
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
)
Object.assign(env, {
  CI: 'true',
  NODE_ENV: 'test',
  DATABASE_URL: target.canonicalUrl,
  RELEASE270_COMPATIBILITY_CONFIRM: DATABASE,
  DIRECT_DATABASE_URL: target.canonicalUrl,
  RAILWAY_ENVIRONMENT: 'staging',
  CLERK_SECRET_KEY: 'test_clerk_secret',
  CLERK_PUBLISHABLE_KEY: 'test_clerk_pub',
  CLERK_WEBHOOK_SECRET: 'test_webhook_secret',
  INTEGRATION_ENCRYPTION_KEY: 'test_encryption_key_32_chars_long!',
  STORAGE_BUCKET: 'test-bucket',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ACCESS_KEY_ID: 'test',
  STORAGE_SECRET_ACCESS_KEY: 'test',
  RESEND_API_KEY: 'test',
  REDIS_URL: 'redis://127.0.0.1:6379',
})
let serial = 0
function run(command, args, cwd, extra = {}, input) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extra },
    input,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
    windowsHide: true,
  })
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(
    /postgres(?:ql)?:\/\/[^\s"'`]+/g,
    '[DISPOSABLE_URL]',
  )
  writeFileSync(
    resolve(
      output,
      `${String(++serial).padStart(3, '0')}-${command.replaceAll(/[^a-z0-9]/gi, '_')}.log`,
    ),
    log,
  )
  assert.equal(result.status, 0, `${command} failed; see artifact ${serial}`)
  return result.stdout.trim()
}
function save(name, data) {
  writeFileSync(resolve(output, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`)
}
const url = new URL(target.canonicalUrl)
const pgEnv = {
  PGHOST: '127.0.0.1',
  PGPORT: url.port,
  PGDATABASE: DATABASE,
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGCONNECT_TIMEOUT: '10',
}
function sql(text) {
  return run('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], candidate, pgEnv, text)
}
function query(text) {
  return JSON.parse(
    sql(`SELECT COALESCE(json_agg(q),'[]'::json) FROM (${text.replace(/;\s*$/, '')}) q;`),
  )
}
function snapshot() {
  const tables = query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  )
  return Object.fromEntries(
    tables.map(({ tablename }) => {
      assert.match(tablename, /^[a-zA-Z0-9_]+$/)
      return [
        tablename,
        JSON.parse(
          sql(
            `SELECT COALESCE(jsonb_agg(r ORDER BY r::text),'[]'::jsonb) FROM (SELECT to_jsonb(t) r FROM "${tablename}" t) s;`,
          ),
        ),
      ]
    }),
  )
}
function manifest(root) {
  const directory = resolve(root, 'packages/db/prisma/migrations')
  return readdirSync(directory, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      hash: createHash('sha256')
        .update(
          readFileSync(resolve(directory, d.name, 'migration.sql'), 'utf8').replaceAll(
            '\r\n',
            '\n',
          ),
        )
        .digest('hex'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
function migrate(root) {
  run(
    process.execPath,
    [
      resolve(root, 'scripts/migrate-disposable-db.mjs'),
      '--database',
      DATABASE,
      '--confirm-database',
      DATABASE,
    ],
    root,
    {
      PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1',
      PATHFINDER_DISPOSABLE_DATABASE_URL: target.canonicalUrl,
    },
  )
}
function ledger(count) {
  const rows = query('SELECT * FROM _prisma_migrations ORDER BY migration_name,id')
  assert.equal(rows.length, count)
  assert.ok(rows.every((r) => r.finished_at && !r.rolled_back_at && r.applied_steps_count > 0))
  return rows
}

assert.equal(run('git', ['rev-parse', 'HEAD'], previous), PREVIOUS_APP)
run('git', ['diff', '--exit-code', 'HEAD', '--'], previous)
const source = run('git', ['rev-parse', 'HEAD'], candidate)
const oldManifest = manifest(previous),
  newManifest = manifest(candidate)
assert.equal(oldManifest.length, 267)
assert.equal(newManifest.length, 270)
assert.deepEqual(newManifest.slice(0, 267), oldManifest)
save('sources', { previous: PREVIOUS_APP, candidate: source, oldManifest, newManifest })
assert.equal(query('SELECT current_database() AS name')[0].name, DATABASE)
assert.equal(
  query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'")[0].count,
  0,
  'fresh empty disposable database required; never reset an existing database',
)
migrate(previous)
ledger(267)
sql(fixtureSql)
const before = snapshot()
save('populated267', before)
migrate(candidate)
ledger(270)
const upgraded = snapshot()
save('populated270', upgraded)
assertUpgradePreservation(before, upgraded)
migrate(candidate)
assert.deepEqual(snapshot(), upgraded, 'repeat migration mutated retained rows')
const catalog = await readRelease270Catalog(async (text) => query(text))
assertRelease270CatalogShape(catalog)
save('catalog270', {
  catalog,
  sha256: release270CatalogHash(catalog),
  reviewStatus: 'unreviewed-reference-not-admission',
})
// Persist new-schema unknown-outcome receipts and ensure the old app retains them.
sql(`INSERT INTO embedding_venue_refreshes(id,tenant_id,venue_id,operation_key,plan_digest,max_records,requested_by,status,before_audit)
 VALUES ('compat-refresh','fictional-release270-compatibility','compat-venue','fictional-operation','fictional-digest',1,'fictional-fixture','OUTCOME_UNKNOWN','{}');
 INSERT INTO embedding_venue_refresh_records(id,refresh_id,tenant_id,venue_id,ordinal,entity_type,entity_id,content_updated_at,source_hash,embedding_profile,primary_reason,status)
 SELECT 'compat-refresh-record','compat-refresh',tenant_id,venue_id,0,'KNOWLEDGE_ENTRY',id,updated_at,'fictional-hash','fictional-profile','fixture','OUTCOME_UNKNOWN' FROM venue_knowledge_entries WHERE content_module_id='compat-event-a';`)
// The historical dispatch suite intentionally leases globally. Schedule only
// our fictional preservation controls beyond its clock, so the unchanged suite
// exercises its own due work while these controls remain observable.
sql(
  `UPDATE embedding_dispatches SET next_attempt_at='2100-01-01 00:00:00' WHERE tenant_id='fictional-release270-compatibility';`,
)
const retained = snapshot()
save('before-historical-app', retained)
// Client is generated FROM THE HISTORICAL schema, in that checkout's independent node_modules.
run('pnpm', ['--dir', 'packages/db', 'db:generate'], previous)
const suites = [
  {
    name: 'historical-db',
    pkg: 'packages/db',
    flag: 'RUN_EMBEDDING_DB_INTEGRATION',
    files: [
      'src/helpers/embedding-work-claims.integration.test.ts',
      'src/helpers/embedding-dispatches.integration.test.ts',
      'src/helpers/embedding-claim-repair.integration.test.ts',
    ],
  },
  {
    name: 'historical-api',
    pkg: 'packages/api',
    flag: 'RUN_CONTENT_HISTORY_DB_INTEGRATION',
    files: ['src/routers/content-history.integration.test.ts'],
  },
]
for (const suite of suites) {
  const report = resolve(output, `${suite.name}.json`)
  run(
    'pnpm',
    [
      '--dir',
      suite.pkg,
      'exec',
      'vitest',
      'run',
      ...suite.files,
      '--pool=forks',
      '--maxWorkers=1',
      '--testTimeout=120000',
      '--reporter=json',
      `--outputFile=${report}`,
    ],
    previous,
    { [suite.flag]: '1' },
  )
  assertHistoricalTests(JSON.parse(readFileSync(report, 'utf8')))
}
// Actual historical generated client reads migrated event text and inserts a fact
// without knowing any of the new applicability fields. No current-client adapter.
run(
  process.execPath,
  [resolve(candidate, 'scripts/release270-compatibility-old-client.mjs'), previous],
  previous,
)
const after = snapshot()
save('after-historical-app', after)
assertRetainedRows(retained, after)
const written = after.operational_fact_content.find(
  (r) => r.revision_id === 'compat-old-write-revision',
)
assert.ok(written)
assert.equal(written.applicability_scope, null)
assert.deepEqual(written.applicability_subject_module_ids, [])
assert.deepEqual(written.applicability_place_ids, [])
run('git', ['diff', '--exit-code', 'HEAD', '--'], previous)
save('result', {
  success: true,
  candidate: source,
  previous: PREVIOUS_APP,
  schemaMigrations: 270,
  populatedUpgrade: true,
  repeatPreserved: true,
  historicalSuites: suites,
  limitations: [
    'Fictional fixture, not restored production backup.',
    'In-process historical API router integration, not deployed HTTP/browser/worker proof.',
    'Catalog reference requires independent review before admission.',
  ],
})
console.log(
  'Historical application read/write compatibility and populated upgrade preservation passed.',
)
