import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildBootstrapReport,
  buildDoctorReport,
  buildRepositoryMap,
  findTests,
  listAgentTools,
  listFixtures,
} from './lib/torchiko-developer-tools.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('developer repository map exposes canonical structured entry points', async () => {
  const report = await buildRepositoryMap(root)
  assert.equal(report.schemaVersion, 1)
  assert.ok(report.entryPoints.applicationRouters.includes('adminRouter'))
  assert.ok(report.entryPoints.adminRouters.includes('adminAgentOperationsRouter'))
  assert.ok(report.counts.testFiles > 500)
  assert.ok(report.counts.migrations > 100)
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
  assert.ok(names.includes('torchiko.prospects.search'))
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

test('bootstrap is inspect-only and retains explicit safety gates', async () => {
  const report = await buildBootstrapReport(root, { NODE_ENV: 'development' })
  assert.match(report.note, /inspect-only/u)
  assert.match(report.note, /seeding/u)
  assert.ok(report.nextCommands.includes('pnpm torchiko doctor --json'))
  assert.ok(report.nextCommands.includes('pnpm --filter @pathfinder/db db:generate'))
})
