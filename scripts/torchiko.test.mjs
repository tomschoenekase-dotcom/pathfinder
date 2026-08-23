import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildBootstrapReport,
  buildCompanyBrainStatus,
  buildConversationReplay,
  buildDoctorReport,
  buildRepositoryMap,
  buildToolCoverageReport,
  classifyRouter,
  findTests,
  listAgentTools,
  listFixtures,
  loadScenarioRegistry,
  loadCompanyBrainScenarioRegistry,
  operationInventoryDigest,
  simulateScenarioLocation,
  simulateScenarioTime,
} from './lib/torchiko-developer-tools.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('developer repository map exposes canonical structured entry points', async () => {
  const report = await buildRepositoryMap(root)
  assert.equal(report.schemaVersion, 1)
  assert.ok(report.entryPoints.applicationRouters.includes('adminRouter'))
  assert.ok(report.entryPoints.adminRouters.includes('adminAgentOperationsRouter'))
  assert.ok(report.counts.testFiles > 500)
  assert.ok(report.counts.migrations > 100)
  assert.ok(report.counts.mcpResources > 20)
})

test('doctor never returns database credentials and makes environment identity explicit', async () => {
  const secret = 'postgresql://secret-user:secret-pass@db.example.com/torchiko'
  const report = await buildDoctorReport(root, {
    NODE_ENV: 'production',
    RAILWAY_ENVIRONMENT: 'production',
    DATABASE_URL: secret,
    DIRECT_DATABASE_URL: secret,
    WORKER_SCHEDULERS_ENABLED: 'false',
  })
  assert.equal(report.environment.databaseTarget, 'external')
  assert.doesNotMatch(JSON.stringify(report), /secret-user|secret-pass/u)
  assert.equal(
    report.gates.every((gate) => gate.enabled === false),
    true,
  )
  assert.ok(report.checks.some((check) => check.id === 'prisma-client'))
})

test('doctor fails closed on ambiguous production identity', async () => {
  const report = await buildDoctorReport(root, { NODE_ENV: 'production' })
  assert.equal(report.healthy, false)
  assert.equal(report.checks.find((check) => check.id === 'environment-identity').status, 'fail')
})

test('tool and fixture discovery reuse canonical sources', async () => {
  const tools = await listAgentTools(root)
  const names = tools.tools.map((tool) => tool.name)
  assert.ok(names.includes('pathfinder.read'))
  assert.ok(names.includes('torchiko.account.get_context'))
  assert.ok(names.includes('torchiko.knowledge.search'))
  assert.ok(names.includes('torchiko.prospects.search'))
  assert.ok(tools.resources.some((resource) => resource.name === 'pathfinder.reports'))
  assert.ok(
    tools.tools.every(
      (tool) => tool.capability && tool.effect && typeof tool.idempotent === 'boolean',
    ),
  )
  assert.equal(
    tools.tools.some((tool) => tool.capability === 'unknown'),
    false,
  )
  assert.equal(
    tools.tools.find((tool) => tool.name === 'torchiko.prospects.save_outreach_draft')
      .humanReviewRequired,
    true,
  )
  const fixtures = await listFixtures(root)
  assert.ok(fixtures.visual.some((fixture) => fixture.route === '/dev-fixtures/billing'))
  assert.ok(fixtures.visual.some((fixture) => fixture.route === '/dev-fixtures'))
  assert.equal(fixtures.lifecycle[0].validate, 'pnpm golden-venue:validate')
})

test('targeted test discovery is bounded and useful', async () => {
  const report = await findTests(root, 'agent-bridge')
  assert.ok(report.matches.some((file) => file.includes('agent-bridge')))
  assert.ok(report.matches.length <= 100)
})

test('every mounted router has exactly one explicit agent/developer coverage decision', async () => {
  const report = await buildToolCoverageReport(root)
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.healthy, true)
  assert.equal(report.classified, report.totalRouters)
  assert.equal(report.unclassified.length, 0)
  assert.equal(report.ambiguous.length, 0)
  assert.ok(report.totalRouters > 60)
  assert.equal(report.operations.total, 371)
  assert.equal(report.operations.classified, report.operations.total)
  assert.equal(report.operations.unclassified.length, 0)
  assert.equal(report.operations.ambiguous.length, 0)
  assert.equal(report.operations.unresolved.length, 0)
  assert.equal(report.operations.reviewedInventory.matches, true)
  assert.equal(report.operations.counts.byKind.query, 162)
  assert.equal(report.operations.counts.byKind.mutation, 209)
  assert.deepEqual(
    report.operations.entries
      .filter((operation) => operation.path === 'admin.listAgentRunTrace')
      .map(({ kind, router, source, categories }) => ({ kind, router, source, categories })),
    [
      {
        kind: 'query',
        router: 'adminAgentRunTraceRouter',
        source: 'packages/api/src/routers/admin/agent-run-trace.ts',
        categories: ['agent-evaluation'],
      },
    ],
  )
})

test('operation inventory digest changes for path, kind, owner, or source drift', () => {
  const baseline = [
    { path: 'admin.example', kind: 'query', router: 'exampleRouter', source: 'example.ts' },
  ]
  const digest = operationInventoryDigest(baseline)
  for (const changed of [
    [{ ...baseline[0], path: 'admin.changed' }],
    [{ ...baseline[0], kind: 'mutation' }],
    [{ ...baseline[0], router: 'changedRouter' }],
    [{ ...baseline[0], source: 'changed.ts' }],
  ]) {
    assert.notEqual(operationInventoryDigest(changed), digest)
  }
})

test('coverage classification fails new unreviewed router names', () => {
  const policy = { categories: [{ id: 'known', pattern: '^knownRouter$' }] }
  assert.equal(classifyRouter('newUnreviewedRouter', policy).length, 0)
})

test('bootstrap is inspect-only and retains explicit safety gates', async () => {
  const report = await buildBootstrapReport(root, { NODE_ENV: 'development' })
  assert.match(report.note, /inspect-only/u)
  assert.match(report.note, /seeding/u)
  assert.ok(report.nextCommands.includes('pnpm torchiko doctor --json'))
  assert.ok(report.nextCommands.includes('pnpm --filter @pathfinder/db db:generate'))
})

test('synthetic scenario registry covers canonical venue shapes', async () => {
  const registry = await loadScenarioRegistry(root)
  assert.equal(registry.healthy, true)
  assert.deepEqual(
    registry.scenarios.map((scenario) => scenario.id),
    ['small-museum', 'outdoor-park', 'attraction', 'large-museum'],
  )
})

test('Company Brain diagnostics discover governed tools and required scenario worlds', async () => {
  const registry = await loadCompanyBrainScenarioRegistry(root)
  assert.equal(registry.healthy, true)
  assert.deepEqual(
    registry.scenarios.map((scenario) => scenario.id),
    [
      'new-prospect',
      'converted-small-museum',
      'mature-multi-venue',
      'difficult-relationship',
      'friend-takeover',
    ],
  )
  const status = await buildCompanyBrainStatus(root)
  assert.equal(status.healthy, true)
  assert.equal(status.tools.missing.length, 0)
  assert.equal(status.shakedown.providerFree, true)
})

test('time and location simulations are deterministic and provider-free', async () => {
  const time = await simulateScenarioTime(root, 'small-museum', '2026-08-24T16:00:00.000Z')
  assert.equal(time.localTime, '11:00')
  assert.equal(time.open, true)
  const location = await simulateScenarioLocation(root, 'small-museum', 41.881, -87.623)
  assert.equal(location.matches[0].id, 'entrance')
  assert.equal(location.matches[0].inside, true)
})

test('conversation replay emits assertions without visitor identity or provider dispatch', async () => {
  const replay = await buildConversationReplay(root, 'large-museum')
  assert.equal(replay.synthetic, true)
  assert.equal(replay.providerDispatch, false)
  assert.ok(replay.assertions.some((item) => item.fact === 'Family Lab'))
  assert.doesNotMatch(JSON.stringify(replay), /visitorId|email|phone|coordinate/iu)
})
