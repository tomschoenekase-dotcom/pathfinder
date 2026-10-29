import assert from 'node:assert/strict'
import test from 'node:test'
import { main, preflightRelease270, spawnRelease270Migration } from './run-release270-migration.mjs'
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { EXPECTED } from './run-staging-migration-predeploy.mjs'
import { RELEASE269_STAGING_REDIS } from './lib/release269-queue-readback.mjs'

const sha = 'a'.repeat(40)
const environment = () => ({
  RAILWAY_ENVIRONMENT: 'staging',
  RAILWAY_ENVIRONMENT_ID: EXPECTED.environmentId,
  RAILWAY_SERVICE_ID: EXPECTED.serviceId,
  DATABASE_RESOURCE_ID: EXPECTED.databaseResourceId,
  RAILWAY_GIT_COMMIT_SHA: sha,
  RAILWAY_PROJECT_ID: RELEASE269_STAGING_REDIS.project,
  REDIS_RESOURCE_ID: RELEASE269_STAGING_REDIS.resource,
  REDIS_URL: `redis://${RELEASE269_STAGING_REDIS.host}:6379`,
  DATABASE_URL: 'postgresql://fictional@database.railway.internal:5432/pathfinder_staging',
  DIRECT_DATABASE_URL: 'postgresql://fictional@database.railway.internal:5432/pathfinder_staging',
})

test('actual main rejects local targets before dependencies, files or connections', async () => {
  for (const key of ['DATABASE_URL', 'DIRECT_DATABASE_URL', 'REDIS_URL']) {
    const env = environment()
    env[key] =
      key === 'REDIS_URL'
        ? 'redis://127.0.0.1:6379'
        : 'postgresql://fictional@127.0.0.1:5432/pathfinder_staging'
    await assert.rejects(main(['--release-sha', sha, '--preflight'], env))
  }
})
test('actual main refuses production and wrong resource/source identities', async () => {
  for (const [key, value] of [
    ['RAILWAY_ENVIRONMENT', 'production'],
    ['DATABASE_RESOURCE_ID', 'fictional-other'],
    ['RAILWAY_GIT_COMMIT_SHA', 'b'.repeat(40)],
  ]) {
    await assert.rejects(
      main(['--release-sha', sha, '--preflight'], { ...environment(), [key]: value }),
    )
  }
})
test('packaging preflight refuses unsupported host or Node injection without connecting', async () => {
  await assert.rejects(
    preflightRelease270('/fictional-unavailable-checkout', sha, { NODE_OPTIONS: '--inspect' }),
  )
})

test('actual Linux process group abort stops parent and descendant activity', async () => {
  const controller = new AbortController()
  if (process.platform !== 'linux') {
    await assert.rejects(
      spawnRelease270Migration({
        cli: '/fictional',
        prismaDirectory: '/fictional',
        environment: {},
        signal: controller.signal,
      }),
      /release270-hosted-linux-runner-required/u,
    )
    return
  }
  const directory = await mkdtemp(
    path.join(process.env.RUNNER_TEMP || tmpdir(), 'release270-process-'),
  )
  const ready = path.join(directory, 'ready')
  const late = path.join(directory, 'late')
  const fixture = path.join(directory, 'fixture.cjs')
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'orphan'), 1200); setInterval(() => {}, 500);`
  await writeFile(
    fixture,
    `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}); setInterval(() => {}, 500);`,
  )
  const child = spawnRelease270Migration({
    cli: fixture,
    prismaDirectory: directory,
    environment: {},
    signal: controller.signal,
  })
  // Attach rejection handler before abort to avoid an unhandled rejection race.
  const rejected = assert.rejects(child, /release270-child-failed/u)
  let started = false
  for (let i = 0; i < 100; i++) {
    try {
      assert.match(await readFile(ready, 'utf8'), /^\d+$/u)
      started = true
      break
    } catch {}
    await setTimeout(20)
  }
  controller.abort()
  await rejected
  assert.equal(started, true, 'descendant never started')
  await setTimeout(1400)
  await assert.rejects(access(late), 'aborted descendant continued writing')
})
