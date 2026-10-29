import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  DATABASE,
  PREVIOUS_APP,
  guardCompatibilityEnvironment,
  assertHistoricalTests,
  assertUpgradePreservation,
  assertRetainedRows,
} from './lib/release270-compatibility.mjs'

const env = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  RELEASE270_COMPATIBILITY_CONFIRM: DATABASE,
  PATHFINDER_DISPOSABLE_DATABASE_URL: `postgresql://postgres:fictional@127.0.0.1:5432/${DATABASE}`,
}
test('admits only explicitly confirmed hosted loopback disposable CI', () => {
  assert.equal(guardCompatibilityEnvironment(env).database, DATABASE)
  for (const change of [
    { GITHUB_ACTIONS: '' },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { RELEASE270_COMPATIBILITY_CONFIRM: '' },
    {
      PATHFINDER_DISPOSABLE_DATABASE_URL: `postgresql://postgres:fictional@remote.example:5432/${DATABASE}`,
    },
    {
      PATHFINDER_DISPOSABLE_DATABASE_URL:
        'postgresql://postgres:fictional@127.0.0.1:5432/production',
    },
  ])
    assert.throws(() => guardCompatibilityEnvironment({ ...env, ...change }))
})
test('a skipped, empty or failed historical suite cannot pass', () => {
  const good = { success: true, numPassedTests: 10, numFailedTests: 0, numPendingTests: 0 }
  assertHistoricalTests(good)
  for (const change of [
    { success: false },
    { numPassedTests: 0 },
    { numFailedTests: 1 },
    { numPendingTests: 1 },
    { numTodoTests: 1 },
  ])
    assert.throws(() => assertHistoricalTests({ ...good, ...change }))
})
test('retention rejects loss or mutation while allowing new historical-app rows', () => {
  const before = { queue: [{ id: 'keep', lease_token: 'unknown' }] }
  assertRetainedRows(before, { queue: [...before.queue, { id: 'new' }] })
  assert.throws(() => assertRetainedRows(before, { queue: [] }))
  assert.throws(() => assertRetainedRows(before, { queue: [{ id: 'keep', lease_token: null }] }))
})
function fixture() {
  const before = {
    venue_knowledge_entries: ['a', 'b'].map((id) => ({
      id,
      tenant_id: 'fixture-tenant',
      venue_id: 'fixture-venue',
      category: 'EVENT',
      content: 'old projection',
      embedding: '[1]',
      updated_at: 'old',
    })),
    embedding_dispatches: [
      {
        id: 'dispatch-a',
        entity_id: 'a',
        content_updated_at: 'old',
        attempts: 3,
        next_attempt_at: 'old',
        lease_token: 'lease',
        lease_expires_at: 'old',
        last_error: 'retry',
        updated_at: 'old',
      },
    ],
    operational_fact_content: [{ revision_id: 'fact', value: 'immutable' }],
    _prisma_migrations: [{ id: '267', checksum: 'unchanged', finished_at: 'old' }],
    content_module_revisions: [{ id: 'source', value: 'immutable' }],
    content_versions: ['a', 'b'].map((id, index) => ({
      id: `prior-${id}`,
      entity_id: id,
      sequence: index + 1,
      after_state: { id, content: 'old projection' },
    })),
  }
  const after = structuredClone(before)
  for (const entry of after.venue_knowledge_entries)
    Object.assign(entry, {
      content: 'Fictional evening program.\nStarts: 2026-11-01T18:30:00.123Z\nEnds: not specified',
      embedding: null,
      updated_at: 'new',
    })
  after.embedding_dispatches = ['a', 'b'].map((id) => ({
    id: `dispatch-${id}`,
    entity_id: id,
    content_updated_at: 'new',
    attempts: 0,
    next_attempt_at: 'new',
    lease_token: null,
    lease_expires_at: null,
    last_error: null,
    updated_at: 'new',
  }))
  Object.assign(after.operational_fact_content[0], {
    applicability_scope: null,
    applicability_subject_module_ids: [],
    applicability_place_ids: [],
  })
  after._prisma_migrations.push(...['268', '269', '270'].map((id) => ({ id })))
  after.content_versions.push(
    ...after.venue_knowledge_entries.map((entry, index) => ({
      id: `new-${entry.id}`,
      entity_id: entry.id,
      sequence: index + 3,
      entity_type: 'KNOWLEDGE_ENTRY',
      tenant_id: entry.tenant_id,
      venue_id: entry.venue_id,
      operation: 'UPDATE',
      snapshot_schema_version: 2,
      actor_id: null,
      reverted_from_id: null,
      venue_package_id: null,
      venue_package_item_key: null,
      venue_package_action: null,
      source_provenance: null,
      before_state: { id: entry.id, content: 'old projection' },
      after_state: { id: entry.id, content: entry.content },
    })),
  )
  return { before, after }
}
test('only reviewed derived changes and default additions are admitted', () => {
  const { before, after } = fixture()
  assertUpgradePreservation(before, after)
  for (const mutate of [
    (data) => {
      data.content_module_revisions[0].value = 'rewritten'
    },
    (data) => {
      data._prisma_migrations[0].checksum = 'rewritten'
    },
    (data) => {
      data.venue_knowledge_entries[0].embedding = '[1]'
    },
    (data) => {
      data.embedding_dispatches[0].lease_token = 'still-leased'
    },
    (data) => {
      data.operational_fact_content[0].applicability_scope = 'VENUE'
    },
    (data) => {
      data.content_versions.pop()
    },
    (data) => {
      data.content_versions[2].actor_id = 'invented-actor'
    },
    (data) => {
      data.content_versions[2].source_provenance = {}
    },
    (data) => {
      data.content_versions[2].before_state.content = 'fabricated'
    },
    (data) => {
      data.content_versions[2].after_state.content = 'fabricated'
    },
    (data) => {
      data.content_versions[2].entity_id = 'unrelated'
    },
    (data) => {
      data.content_versions[0].after_state.content = 'rewritten-history'
    },
  ]) {
    const damaged = structuredClone(after)
    mutate(damaged)
    assert.throws(() => assertUpgradePreservation(before, damaged))
  }
})
test('workflow runs immutable historical checkout and independent installs', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release270-compatibility.yml', import.meta.url),
    'utf8',
  )
  assert.ok(workflow.includes(`ref: ${PREVIOUS_APP}`))
  assert.ok(workflow.includes('pnpm --dir previous install --frozen-lockfile'))
  assert.ok(workflow.includes('persist-credentials: false'))
  assert.ok(!workflow.includes('secrets.'))
})
