import assert from 'node:assert/strict'
import { validateDisposableDatabaseUrl } from './disposable-prisma-migration.mjs'

export const PREVIOUS_APP = 'a18fde4b947561b70c1909c5df134ae3b1fef4e4'
export const DATABASE = 'pathfinder_disposable_release270_compatibility'
export const TENANT = 'fictional-release270-compatibility'

export function guardCompatibilityEnvironment(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'hosted disposable CI only')
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'self-hosted runners are not admitted')
  assert.equal(
    env.RELEASE270_COMPATIBILITY_CONFIRM,
    DATABASE,
    'explicit disposable confirmation required',
  )
  return validateDisposableDatabaseUrl(env.PATHFINDER_DISPOSABLE_DATABASE_URL, DATABASE)
}

export function assertHistoricalTests(report) {
  assert.equal(report.success, true, 'historical suite failed')
  assert.ok(report.numPassedTests > 0, 'historical suite did not execute')
  assert.equal(report.numFailedTests, 0)
  assert.equal(report.numPendingTests, 0, 'skipped historical tests are not compatibility proof')
  assert.equal(report.numTodoTests ?? 0, 0)
}

// Preserve every row, including failed/rolled-back physical migration ledger rows.
// Only these two known EVENT projections and their dispatches may change at 268.
export function assertUpgradePreservation(before, after) {
  const eventIds = new Set(
    before.venue_knowledge_entries.filter((r) => r.category === 'EVENT').map((r) => r.id),
  )
  assert.equal(eventIds.size, 2, 'both populated EVENT fixtures are required')
  for (const [table, rows] of Object.entries(before)) {
    assert.ok(after[table], `missing table ${table}`)
    for (const row of rows) {
      const updated = after[table].find(
        (r) => (r.id ?? r.revision_id) === (row.id ?? row.revision_id),
      )
      assert.ok(updated, `lost ${table} row`)
      const old = { ...row },
        next = { ...updated }
      if (table === 'operational_fact_content') {
        assert.equal(next.applicability_scope, null)
        assert.deepEqual(next.applicability_subject_module_ids, [])
        assert.deepEqual(next.applicability_place_ids, [])
        for (const key of [
          'applicability_scope',
          'applicability_subject_module_ids',
          'applicability_place_ids',
        ])
          delete next[key]
      }
      if (table === 'venue_knowledge_entries' && eventIds.has(row.id)) {
        assert.notEqual(updated.content, row.content, '268 must actually rewrite fixture text')
        assert.equal(
          updated.content,
          'Fictional evening program.\nStarts: 2026-11-01T18:30:00.123Z\nEnds: not specified',
        )
        assert.notEqual(row.embedding, null, 'fixture must have a populated vector')
        assert.equal(updated.embedding, null, '268 must invalidate the stale vector')
        for (const key of ['content', 'embedding', 'updated_at']) {
          delete old[key]
          delete next[key]
        }
      }
      if (table === 'embedding_dispatches' && eventIds.has(row.entity_id)) {
        for (const key of [
          'content_updated_at',
          'attempts',
          'next_attempt_at',
          'lease_token',
          'lease_expires_at',
          'last_error',
          'updated_at',
        ]) {
          delete old[key]
          delete next[key]
        }
      }
      assert.deepEqual(next, old, `unexpected mutation in ${table}`)
    }
    const allowedNew =
      table === '_prisma_migrations'
        ? 3
        : table === 'embedding_dispatches'
          ? 1
          : table === 'content_versions'
            ? 2
            : 0
    assert.equal(after[table].length, rows.length + allowedNew, `unexpected row count in ${table}`)
  }
  for (const id of eventIds) {
    const entry = after.venue_knowledge_entries.find((r) => r.id === id)
    const dispatch = after.embedding_dispatches.find((r) => r.entity_id === id)
    assert.ok(dispatch, 'missing regenerated EVENT dispatch')
    assert.equal(dispatch.attempts, 0)
    assert.equal(dispatch.lease_token, null)
    assert.equal(dispatch.lease_expires_at, null)
    assert.equal(dispatch.last_error, null)
    assert.equal(dispatch.content_updated_at, entry.updated_at)
  }
  const priorVersions = before.content_versions
  assert.ok(Array.isArray(priorVersions), 'populated append-only history is required')
  const oldVersionIds = new Set(priorVersions.map((r) => r.id))
  const addedVersions = after.content_versions.filter((r) => !oldVersionIds.has(r.id))
  assert.equal(addedVersions.length, 2, 'exactly two derived-projection history additions required')
  assert.deepEqual(new Set(addedVersions.map((r) => r.entity_id)), eventIds)
  const lastSequence = Math.max(...priorVersions.map((r) => Number(r.sequence)))
  assert.equal(new Set(addedVersions.map((r) => r.sequence)).size, 2)
  for (const version of addedVersions) {
    const entry = after.venue_knowledge_entries.find((r) => r.id === version.entity_id)
    const prior = priorVersions
      .filter((r) => r.entity_id === version.entity_id)
      .sort((a, b) => Number(b.sequence) - Number(a.sequence))[0]
    assert.ok(prior, 'each rewritten projection needs its immutable before-history')
    assert.equal(version.entity_type, 'KNOWLEDGE_ENTRY')
    assert.equal(version.operation, 'UPDATE')
    assert.equal(version.tenant_id, entry.tenant_id)
    assert.equal(version.venue_id, entry.venue_id)
    assert.equal(version.snapshot_schema_version, 2)
    assert.ok(Number(version.sequence) > lastSequence)
    for (const key of [
      'actor_id',
      'reverted_from_id',
      'venue_package_id',
      'venue_package_item_key',
      'venue_package_action',
      'source_provenance',
    ])
      assert.equal(version[key], null, `migration history must not invent ${key}`)
    assert.deepEqual(version.before_state, prior.after_state)
    assert.deepEqual(version.after_state, { ...prior.after_state, content: entry.content })
  }
}

export function assertRetainedRows(before, after) {
  for (const [table, rows] of Object.entries(before)) {
    for (const row of rows)
      assert.ok(
        after[table]?.some((r) => JSON.stringify(r) === JSON.stringify(row)),
        `historical app changed retained ${table} row`,
      )
  }
}

export const fixtureSql = `
BEGIN;
INSERT INTO tenants(id,name,slug,updated_at) VALUES ('${TENANT}','Fictional compatibility museum','${TENANT}',CURRENT_TIMESTAMP);
INSERT INTO venues(id,tenant_id,name,slug,updated_at) VALUES ('compat-venue','${TENANT}','Fictional evening gallery','compat-venue',CURRENT_TIMESTAMP);
INSERT INTO content_module_identities(id,tenant_id,venue_id,kind) VALUES
 ('compat-event-a','${TENANT}','compat-venue','EVENT'),('compat-event-b','${TENANT}','compat-venue','EVENT'),('compat-fact','${TENANT}','compat-venue','OPERATIONAL_FACT');
INSERT INTO content_module_revisions(id,tenant_id,venue_id,module_id,kind,version,audience,created_by)
 SELECT id||'-revision',tenant_id,venue_id,id,kind,1,'PUBLIC','fictional-fixture' FROM content_module_identities WHERE tenant_id='${TENANT}';
INSERT INTO event_content(revision_id,tenant_id,venue_id,name,description,starts_at)
 SELECT id,tenant_id,venue_id,'Fictional evening program','Fictional evening program.','2026-11-01 18:30:00.123' FROM content_module_revisions WHERE tenant_id='${TENANT}' AND kind='EVENT';
INSERT INTO operational_fact_content(revision_id,tenant_id,venue_id,label,value)
 VALUES ('compat-fact-revision','${TENANT}','compat-venue','Fictional entry','Use the east door.');
INSERT INTO content_module_publications(id,tenant_id,venue_id,module_id,revision_id,module_kind,action,request_id,actor_id)
 SELECT id||'-publication',tenant_id,venue_id,module_id,id,kind,'PUBLISH',md5(id)::uuid,'fictional-fixture' FROM content_module_revisions WHERE tenant_id='${TENANT}';
UPDATE venue_knowledge_entries SET embedding=('['||rtrim(repeat('0.1,',1536),',')||']')::vector WHERE tenant_id='${TENANT}' AND category='EVENT';
UPDATE embedding_dispatches SET attempts=3,lease_token='fictional-lease',lease_expires_at=CURRENT_TIMESTAMP+INTERVAL '1 hour',last_error='fictional retry' WHERE tenant_id='${TENANT}';
DELETE FROM embedding_dispatches WHERE entity_id IN (SELECT id FROM venue_knowledge_entries WHERE content_module_id='compat-event-b');
COMMIT;
`
