import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import {
  RELEASE269_STAGING_REDIS as target,
  RELEASE269_QUEUE_BASE_NAMES,
  RELEASE269_QUEUE_COUNTS_LUA,
  assertRelease269StagingRedis,
  readRelease269StagingQueues,
} from './lib/release269-queue-readback.mjs'

const sha = 'a'.repeat(40)
const environment = () => ({
  RAILWAY_PROJECT_ID: target.project,
  RAILWAY_ENVIRONMENT_ID: target.environment,
  RAILWAY_ENVIRONMENT: 'staging',
  RAILWAY_SERVICE_ID: target.service,
  REDIS_RESOURCE_ID: target.resource,
  REDIS_URL: `redis://default:synthetic-private@${target.host}:6379/0`,
})
const names = RELEASE269_QUEUE_BASE_NAMES.map((name) => `staging--${name}`)
const zero = () =>
  Object.fromEntries(
    names.map((name) => [
      name,
      { waiting: 0, active: 0, delayed: 0, prioritized: 0, waitingChildren: 0, failed: 0 },
    ]),
  )
function fixture({ counts = zero(), elapsed = 10, failure, raw } = {}) {
  const calls = []
  let time = Date.parse('2026-10-26T04:00:00.000Z')
  return {
    calls,
    run: (env = environment()) =>
      readRelease269StagingQueues({
        environment: env,
        releaseSha: sha,
        now: () => {
          const prior = time
          time += elapsed
          return prior
        },
        createConnection: (url, options) => {
          calls.push({ kind: 'create', url, options })
          return {
            on: (...args) => calls.push({ kind: 'on', event: args[0] }),
            connect: async () => {
              calls.push({ kind: 'connect' })
              if (failure === 'connect') throw new Error(url)
            },
            call: async (...args) => {
              calls.push({ kind: 'command', args })
              if (failure === 'command') throw new Error(url)
              return raw ?? JSON.stringify(counts)
            },
            disconnect: () => {
              calls.push({ kind: 'disconnect' })
              if (failure === 'disconnect') throw new Error(url)
            },
          }
        },
      }),
  }
}

test('frozen queue inventory equals every operational source queue without importing application config', async () => {
  const source = await readFile(new URL('../packages/jobs/src/queues.ts', import.meta.url), 'utf8')
  const declarations = [
    ...source.matchAll(/export const (\w+_QUEUE) = queueName\(\s*'([a-z0-9-]+)'\s*,?\s*\)/gu),
  ]
  const declarationMap = new Map(declarations.map((match) => [match[1], match[2]]))
  const body = source.match(/OPERATIONAL_QUEUE_NAMES = Object\.freeze\(\[([\s\S]*?)\]/u)[1]
  const registry = body
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  assert.equal(registry.length, declarationMap.size)
  assert.equal(new Set(registry).size, registry.length)
  assert.deepEqual(
    registry.map((name) => declarationMap.get(name)),
    [...RELEASE269_QUEUE_BASE_NAMES],
  )
})

test('pinned live read checks every pending state atomically and returns only aggregate evidence', async () => {
  const counts = zero()
  counts[names[0]].failed = 4 // Failed history is preserved; it is not pending work.
  const f = fixture({ counts })
  const result = await f.run()
  assert.equal(result.resourceIdentity, target.resource)
  assert.equal(result.observedAt, '2026-10-26T04:00:00.010Z')
  assert.deepEqual(result.registry, names)
  assert.equal(result.coverage, 'all-application-queues')
  for (const key of ['waiting', 'active', 'delayed', 'prioritized', 'waitingChildren'])
    assert.equal(result[key], 0)
  const commands = f.calls.filter((call) => call.kind === 'command')
  assert.equal(commands.length, 1)
  assert.deepEqual(commands[0].args, ['EVAL_RO', RELEASE269_QUEUE_COUNTS_LUA, '0', ...names])
  assert.match(RELEASE269_QUEUE_COUNTS_LUA, /'paused'/u)
  assert.deepEqual(
    [
      ...new Set(
        [...RELEASE269_QUEUE_COUNTS_LUA.matchAll(/redis\.call\('([A-Z_]+)'/gu)].map(
          (match) => match[1],
        ),
      ),
    ].sort(),
    ['LLEN', 'ZCARD'],
  )
  assert.equal(f.calls.at(-1).kind, 'disconnect')
  const options = f.calls[0].options
  assert.equal(options.enableOfflineQueue, false)
  assert.equal(options.retryStrategy(), null)
  assert.equal(options.commandTimeout, 10000)
  assert.ok(!JSON.stringify(result).includes('synthetic-private'))
})

test('target drift and URL variants refuse before opening Redis', async () => {
  const patches = [
    { RAILWAY_PROJECT_ID: 'wrong' },
    { RAILWAY_ENVIRONMENT_ID: 'wrong' },
    { RAILWAY_ENVIRONMENT: 'production' },
    { RAILWAY_SERVICE_ID: 'wrong' },
    { REDIS_RESOURCE_ID: 'wrong' },
    { RELEASE269_QUEUE_RESOURCE_ID: 'wrong' },
    { REDIS_URL: undefined },
    { REDIS_URL: 'invalid' },
    { REDIS_URL: `redis://wrong.railway.internal:6379/0` },
    { REDIS_URL: `redis://${target.host}:6380/0` },
    { REDIS_URL: `redis://${target.host}:6379/1` },
    { REDIS_URL: `redis://${target.host}:6379/0?db=1` },
    { REDIS_URL: `http://${target.host}:6379/0` },
  ]
  for (const patch of patches) {
    const f = fixture()
    await assert.rejects(f.run({ ...environment(), ...patch }))
    assert.deepEqual(f.calls, [])
  }
  assert.equal(assertRelease269StagingRedis(environment()), target.resource)
})

test('positive, missing, malformed or extra counts and incomplete registry cannot attest a drain', async () => {
  for (const key of ['waiting', 'active', 'delayed', 'prioritized', 'waitingChildren']) {
    const counts = zero()
    counts[names[0]][key] = 1
    await assert.rejects(fixture({ counts }).run(), /live-queue-read-refused/u)
  }
  for (const mutate of [
    (counts) => {
      delete counts[names[0]]
    },
    (counts) => {
      counts['staging--unreviewed'] = counts[names[0]]
    },
    (counts) => {
      delete counts[names[0]].waitingChildren
    },
    (counts) => {
      counts[names[0]].waiting = '0'
    },
    (counts) => {
      counts[names[0]].waiting = -1
    },
    (counts) => {
      counts[names[0]].extra = 0
    },
  ]) {
    const counts = zero()
    mutate(counts)
    await assert.rejects(fixture({ counts }).run(), /live-queue-read-refused/u)
  }
  for (const raw of ['null', '[]', 'malformed', 'x'.repeat(131073)])
    await assert.rejects(fixture({ raw }).run(), /live-queue-read-refused/u)
})

test('bounded failures and stale reads disconnect without leaking connection strings', async () => {
  for (const options of [
    { failure: 'connect' },
    { failure: 'command' },
    { failure: 'disconnect' },
    { elapsed: 15001 },
    { elapsed: -1 },
  ]) {
    const f = fixture(options)
    await assert.rejects(f.run(), (error) => {
      assert.match(error.message, /^release269-(live-queue-read-refused|queue-disconnect-failed)$/u)
      assert.ok(!error.message.includes('synthetic-private'))
      return true
    })
    assert.equal(f.calls.at(-1).kind, 'disconnect')
  }
})
