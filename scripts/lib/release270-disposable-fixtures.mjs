// Fictional, disposable-only setup. Never imported by an operational runner.
import assert from 'node:assert/strict'
import { RELEASE269_QUEUE_BASE_NAMES } from './release269-queue-readback.mjs'

// Run after the compatibility fixture and unchanged migrations through269.
// Insert a NEW immutable revision instead of updating append-only fact content.
export const fixtureSql269 = `
BEGIN;
INSERT INTO content_module_identities(id,tenant_id,venue_id,kind)
 VALUES ('fictional-270-scoped-fact','fictional-release270-compatibility','compat-venue','OPERATIONAL_FACT');
INSERT INTO content_module_revisions(id,tenant_id,venue_id,module_id,kind,version,audience,created_by)
 VALUES ('fictional-270-scoped-revision','fictional-release270-compatibility','compat-venue','fictional-270-scoped-fact','OPERATIONAL_FACT',1,'PUBLIC','fictional-fixture');
INSERT INTO operational_fact_content(revision_id,tenant_id,venue_id,label,value,applicability_scope,applicability_subject_module_ids,applicability_place_ids)
 VALUES ('fictional-270-scoped-revision','fictional-release270-compatibility','compat-venue','Fictional scoped fact','Use the fictional gallery entrance.','SUBJECTS',ARRAY['compat-event-a'],ARRAY['fictional-east-gallery']);
INSERT INTO venue_knowledge_entries(id,tenant_id,venue_id,title,category,content,created_at,updated_at,embedding)
 VALUES ('fictional-270-vector-control','fictional-release270-compatibility','compat-venue','Fictional retained vector','GENERAL','Fictional preservation control.','2026-10-29T00:00:00.123456Z','2026-10-29T00:00:00.234567Z',('['||rtrim(repeat('0.2,',1536),',')||']')::vector);
COMMIT;
`
export const source269PostBootstrapSql = fixtureSql269

export async function seedRelease270DormantRedis(connection, { confirm } = {}) {
  assert.equal(
    confirm,
    'fictional-release270-disposable',
    'release270-fixture-confirmation-required',
  )
  assert.ok(
    ['127.0.0.1', 'localhost', '::1'].includes(connection?.options?.host),
    'release270-fixture-local-redis-required',
  )
  assert.equal(Number(connection.options.db ?? 0), 0, 'release270-fixture-redis-db-required')
  assert.equal(
    Number(await connection.call('DBSIZE')),
    0,
    'release270-fixture-fresh-redis-required',
  )
  for (const name of RELEASE269_QUEUE_BASE_NAMES)
    await connection.call('HSET', `bull:staging--${name}:meta`, 'fictional-fixture', 'release270')
  for (const [base, name, state] of [
    ['gmail-sync', 'gmail-sync-reconciliation', 'wait'],
    ['prospect-import', 'prospect-import-inspect', 'wait'],
    ['intake-upload-verification', 'intake-upload-verification-process', 'wait'],
    ['analytics-enrichment', 'analytics-enrichment-scheduler', 'delayed'],
    ['daily-rollup', 'daily-rollup-scheduler', 'delayed'],
    ['weekly-digest', 'weekly-digest-scheduler', 'delayed'],
    ['account-summary-refresh', 'account-summary-refresh-scheduler', 'delayed'],
  ]) {
    const prefix = `bull:staging--${base}:`,
      id = `fictional-${base}`
    await connection.call(
      'HSET',
      prefix + id,
      'name',
      name,
      'attemptsMade',
      '0',
      'ats',
      '0',
      'data',
      '{"fictional":true}',
    )
    if (state === 'wait') await connection.call('RPUSH', prefix + state, id)
    else await connection.call('ZADD', prefix + state, '4102444800000', id)
  }
  const prefix = 'bull:staging--daily-rollup:'
  await connection.call('SET', prefix + 'id', '123')
  await connection.call('SADD', prefix + 'fictional-members', 'a', 'b')
  await connection.call('XADD', prefix + 'events', '1-0', 'event', 'fictional')
  await connection.call(
    'HSET',
    prefix + 'fictional-failed',
    'name',
    'fictional-failed',
    'attemptsMade',
    '1',
    'data',
    '{"fictional":true}',
  )
  await connection.call('ZADD', prefix + 'failed', '1', 'fictional-failed')
  return { fictional: true, dormantJobs: 7, registeredQueues: RELEASE269_QUEUE_BASE_NAMES.length }
}
export const seedRelease270Redis = seedRelease270DormantRedis
