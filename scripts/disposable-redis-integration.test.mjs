import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DisposableRedisExecutionError,
  DisposableRedisRefusal,
  buildDisposableRedisChildEnv,
  parsePublishedRedisPort,
  runDisposableRedisIntegration,
  runGuardedRedisSuite,
  validateLocalDockerEndpoint,
  validateVitestJsonReport,
} from './lib/disposable-redis-integration.mjs'

test('accepts only one exact IPv4-loopback Docker port mapping', () => {
  assert.equal(parsePublishedRedisPort('127.0.0.1:49152\n'), 49_152)
  for (const value of [
    '0.0.0.0:49152',
    '[::1]:49152',
    '127.0.0.1:0',
    '127.0.0.1:65536',
    '127.0.0.1:49152\n127.0.0.1:49153',
    '49152',
  ]) {
    assert.throws(() => parsePublishedRedisPort(value), DisposableRedisExecutionError)
  }
})

test('builds isolated, credential-free suite environments with exact confirmations', () => {
  const parent = {
    PATH: 'retained',
    NODE_OPTIONS: '--inspect',
    REDIS_URL: 'redis://user:secret@external.example',
    RAILWAY_ENVIRONMENT: 'production',
    RUN_GENERATION_RECOVERY_REDIS_INTEGRATION: 'inherited',
    RUN_GENERATION_DISPATCH_REDIS_INTEGRATION: 'inherited',
    RUN_TERMINAL_REDRIVE_REDIS_INTEGRATION: 'inherited',
    PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION: 'inherited',
    PATHFINDER_ALLOW_EXISTING_DISPOSABLE_REDIS: 'inherited',
    PATHFINDER_EXISTING_DISPOSABLE_REDIS_CONFIRMATION: 'inherited',
    DATABASE_URL: 'postgresql://user:secret@external.example/prod',
    CLERK_SECRET_KEY: 'secret',
    STORAGE_SECRET_ACCESS_KEY: 'secret',
    TURBO_TOKEN: 'secret',
  }
  const recovery = buildDisposableRedisChildEnv(parent, 49_152, 'recovery')
  assert.equal(recovery.PATH, 'retained')
  assert.equal(recovery.NODE_OPTIONS, undefined)
  assert.equal(recovery.DATABASE_URL, undefined)
  assert.equal(recovery.CLERK_SECRET_KEY, undefined)
  assert.equal(recovery.STORAGE_SECRET_ACCESS_KEY, undefined)
  assert.equal(recovery.TURBO_TOKEN, undefined)
  assert.equal(recovery.REDIS_URL, 'redis://127.0.0.1:49152')
  assert.equal(recovery.RAILWAY_ENVIRONMENT, 'preview')
  assert.equal(recovery.RUN_GENERATION_RECOVERY_REDIS_INTEGRATION, '1')
  assert.equal(recovery.RUN_GENERATION_DISPATCH_REDIS_INTEGRATION, undefined)
  assert.equal(recovery.RUN_TERMINAL_REDRIVE_REDIS_INTEGRATION, undefined)
  assert.equal(recovery.PATHFINDER_ALLOW_EXISTING_DISPOSABLE_REDIS, undefined)
  assert.equal(recovery.PATHFINDER_EXISTING_DISPOSABLE_REDIS_CONFIRMATION, undefined)
  assert.equal(
    recovery.PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION,
    'pathfinder_disposable_generation_recovery',
  )
  const dispatch = buildDisposableRedisChildEnv(parent, 49_153, 'dispatch')
  assert.equal(dispatch.RUN_GENERATION_RECOVERY_REDIS_INTEGRATION, undefined)
  assert.equal(dispatch.RUN_GENERATION_DISPATCH_REDIS_INTEGRATION, '1')
  assert.equal(
    dispatch.PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION,
    'pathfinder_disposable_generation_dispatch',
  )
  const redrive = buildDisposableRedisChildEnv(parent, 49_154, 'terminal-redrive')
  assert.equal(redrive.RUN_GENERATION_RECOVERY_REDIS_INTEGRATION, undefined)
  assert.equal(redrive.RUN_GENERATION_DISPATCH_REDIS_INTEGRATION, undefined)
  assert.equal(redrive.RUN_TERMINAL_REDRIVE_REDIS_INTEGRATION, '1')
  assert.equal(
    redrive.PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION,
    'pathfinder_disposable_terminal_redrive',
  )
})

test('requires machine-readable proof of exactly two executed tests per suite', () => {
  const passing = JSON.stringify({
    success: true,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numSkippedTests: 0,
    numTodoTests: 0,
    numTotalTests: 2,
    testResults: [{ assertionResults: [{ status: 'passed' }, { status: 'passed' }] }],
  })
  assert.deepEqual(validateVitestJsonReport(passing, 'recovery'), { passed: 2 })
  for (const report of [
    'not-json',
    JSON.stringify({
      success: true,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 2,
      numSkippedTests: 2,
      numTodoTests: 0,
      numTotalTests: 2,
      testResults: [{ assertionResults: [{ status: 'pending' }, { status: 'pending' }] }],
    }),
    JSON.stringify({
      success: false,
      numPassedTests: 1,
      numFailedTests: 1,
      numPendingTests: 0,
      numSkippedTests: 0,
      numTodoTests: 0,
      numTotalTests: 2,
      testResults: [{ assertionResults: [{ status: 'passed' }, { status: 'failed' }] }],
    }),
    JSON.stringify({
      success: true,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 0,
      numSkippedTests: 0,
      numTodoTests: 1,
      numTotalTests: 3,
      testResults: [
        {
          assertionResults: [{ status: 'passed' }, { status: 'passed' }, { status: 'todo' }],
        },
      ],
    }),
  ]) {
    assert.throws(() => validateVitestJsonReport(report, 'recovery'), DisposableRedisExecutionError)
  }
})

test('accepts only local Docker daemon endpoints', () => {
  assert.equal(
    validateLocalDockerEndpoint('npipe:////./pipe/dockerDesktopLinuxEngine'),
    'npipe:////./pipe/dockerDesktopLinuxEngine',
  )
  assert.equal(
    validateLocalDockerEndpoint('unix:///var/run/docker.sock'),
    'unix:///var/run/docker.sock',
  )
  for (const endpoint of ['tcp://127.0.0.1:2375', 'tcp://remote.example:2376', 'ssh://host', '']) {
    assert.throws(() => validateLocalDockerEndpoint(endpoint), DisposableRedisRefusal)
  }
})

function fakeRuntime({
  cleanupFails = false,
  readinessNever = false,
  runFails = false,
  skippedRecovery = false,
  skippedTerminal = false,
} = {}) {
  let running = false
  let containerName = ''
  const calls = []
  const suiteEnvironments = []
  const report = (pending = false) =>
    JSON.stringify({
      success: true,
      numPassedTests: pending ? 0 : 2,
      numFailedTests: 0,
      numPendingTests: pending ? 2 : 0,
      numSkippedTests: pending ? 2 : 0,
      numTodoTests: 0,
      numTotalTests: 2,
      testResults: [
        {
          assertionResults: [
            { status: pending ? 'pending' : 'passed' },
            { status: pending ? 'pending' : 'passed' },
          ],
        },
      ],
    })

  return {
    calls,
    suiteEnvironments,
    isRunning: () => running,
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options })
      assert.equal(options.shell, false)
      if (command === 'docker' && args[0] === 'context' && args[1] === 'show') {
        assert.equal(options.env.DOCKER_HOST, undefined)
        return { status: 0, stdout: 'desktop-linux\n', stderr: '' }
      }
      if (command === 'docker' && args[0] === 'context' && args[1] === 'inspect') {
        assert.equal(args[2], 'desktop-linux')
        return {
          status: 0,
          stdout: '"npipe:////./pipe/dockerDesktopLinuxEngine"\n',
          stderr: '',
        }
      }
      if (command === 'docker') {
        assert.equal(options.env.DOCKER_HOST, 'npipe:////./pipe/dockerDesktopLinuxEngine')
        assert.equal(options.env.DOCKER_CONTEXT, undefined)
      }
      if (command === 'docker' && args[0] === 'ps') {
        return { status: 0, stdout: running ? `${containerName}\n` : '', stderr: '' }
      }
      if (command === 'docker' && args[0] === 'run') {
        containerName = args[args.indexOf('--name') + 1]
        assert.match(containerName, /^pathfinder-disposable-redis-[a-z0-9-]+$/u)
        assert.deepEqual(args.slice(args.indexOf('--publish'), args.indexOf('--publish') + 2), [
          '--publish',
          '127.0.0.1::6379',
        ])
        if (runFails) return { status: 1, stdout: '', stderr: 'start failed' }
        running = true
        return { status: 0, stdout: 'container-id\n', stderr: '' }
      }
      if (command === 'docker' && args[0] === 'exec') {
        if (readinessNever) return { status: 1, stdout: '', stderr: 'not ready' }
        return { status: 0, stdout: 'PONG\n', stderr: '' }
      }
      if (command === 'docker' && args[0] === 'port') {
        return { status: 0, stdout: '127.0.0.1:49152\n', stderr: '' }
      }
      if (command === 'docker' && args[0] === 'rm') {
        assert.equal(args[2], containerName)
        if (cleanupFails) return { status: 1, stdout: '', stderr: 'cleanup failed' }
        running = false
        return { status: 0, stdout: `${containerName}\n`, stderr: '' }
      }
      if (command === process.execPath) {
        suiteEnvironments.push(options.env)
        const isRecovery = args.includes('src/generation-recovery.integration.test.ts')
        const isTerminal = args.includes('src/terminal-redrive.integration.test.ts')
        return {
          status: 0,
          stdout: report((skippedRecovery && isRecovery) || (skippedTerminal && isTerminal)),
          stderr: '',
        }
      }
      throw new Error(`Unexpected fake command: ${command} ${args.join(' ')}`)
    },
  }
}

test('the shared CI gate proves two terminal-redrive tests ran and rejects a silent skip', () => {
  const passing = fakeRuntime()
  const stdout = {
    value: '',
    write(value) {
      this.value += value
    },
  }
  assert.equal(
    runGuardedRedisSuite({
      suite: 'terminal-redrive',
      env: {
        npm_execpath: 'pnpm-cli.cjs',
        REDIS_URL: 'redis://localhost:6379',
        PATHFINDER_ALLOW_EXISTING_DISPOSABLE_REDIS: '1',
        PATHFINDER_EXISTING_DISPOSABLE_REDIS_CONFIRMATION: 'pathfinder_ci_owned_disposable_redis',
      },
      spawnSyncImpl: passing.spawnSyncImpl,
      stdout,
      stderr: { write() {} },
      repositoryRoot: 'C:/pathfinder',
    }),
    0,
  )
  assert.equal(passing.suiteEnvironments.length, 1)
  assert.match(stdout.value, /terminal-redrive suite: 2\/2 passed/u)

  const skipped = fakeRuntime({ skippedTerminal: true })
  assert.throws(
    () =>
      runGuardedRedisSuite({
        suite: 'terminal-redrive',
        env: {
          npm_execpath: 'pnpm-cli.cjs',
          REDIS_URL: 'redis://127.0.0.1:6379',
          PATHFINDER_ALLOW_EXISTING_DISPOSABLE_REDIS: '1',
          PATHFINDER_EXISTING_DISPOSABLE_REDIS_CONFIRMATION: 'pathfinder_ci_owned_disposable_redis',
        },
        spawnSyncImpl: skipped.spawnSyncImpl,
        stdout: { write() {} },
        stderr: { write() {} },
        repositoryRoot: 'C:/pathfinder',
      }),
    /must execute exactly two passing/u,
  )
})

test('the shared gate refuses before spawn without exact existing-disposable confirmation', () => {
  let spawned = false
  assert.throws(
    () =>
      runGuardedRedisSuite({
        suite: 'terminal-redrive',
        env: { npm_execpath: 'pnpm-cli.cjs', REDIS_URL: 'redis://127.0.0.1:6379' },
        spawnSyncImpl() {
          spawned = true
          throw new Error('must not spawn')
        },
      }),
    /exact disposable-target confirmation/u,
  )
  assert.equal(spawned, false)
})

test('requires an explicit package lifecycle or environment opt-in before Docker inspection', async () => {
  const neverSpawn = () => {
    throw new Error('Docker must not be inspected before opt-in')
  }
  await assert.rejects(
    runDisposableRedisIntegration({
      env: { npm_execpath: 'pnpm-cli.cjs' },
      spawnSyncImpl: neverSpawn,
    }),
    DisposableRedisRefusal,
  )
})

test('rejects inherited and inspected remote Docker daemon endpoints before mutation', async () => {
  await assert.rejects(
    runDisposableRedisIntegration({
      env: {
        npm_execpath: 'pnpm-cli.cjs',
        npm_lifecycle_event: 'test:redis:disposable',
        DOCKER_HOST: 'tcp://remote.example:2376',
      },
      spawnSyncImpl: () => {
        throw new Error('Docker must not run with inherited DOCKER_HOST')
      },
    }),
    /Unset DOCKER_HOST/u,
  )

  const calls = []
  await assert.rejects(
    runDisposableRedisIntegration({
      env: {
        npm_execpath: 'pnpm-cli.cjs',
        npm_lifecycle_event: 'test:redis:disposable',
      },
      spawnSyncImpl(command, args, options) {
        calls.push({ command, args, options })
        if (args[1] === 'show') return { status: 0, stdout: 'remote\n', stderr: '' }
        if (args[1] === 'inspect') {
          return { status: 0, stdout: '"tcp://remote.example:2376"\n', stderr: '' }
        }
        throw new Error('Container mutation must not run for a remote context')
      },
    }),
    /requires a local npipe or Unix-socket/u,
  )
  assert.equal(calls.length, 2)
})

test('runs all suites without a shell and always verifies exact-container cleanup', async () => {
  const runtime = fakeRuntime()
  const stdout = {
    value: '',
    write(value) {
      this.value += value
    },
  }
  await assert.doesNotReject(
    runDisposableRedisIntegration({
      env: {
        npm_execpath: 'pnpm-cli.cjs',
        npm_lifecycle_event: 'test:redis:disposable',
        REDIS_URL: 'redis://external.example:6379',
      },
      spawnSyncImpl: runtime.spawnSyncImpl,
      waitImpl: async () => {},
      stdout,
      stderr: { write() {} },
      repositoryRoot: 'C:/pathfinder',
    }),
  )
  assert.equal(runtime.suiteEnvironments.length, 3)
  assert.equal(runtime.isRunning(), false)
  assert.match(stdout.value, /recovery suite: 2\/2 passed/u)
  assert.match(stdout.value, /dispatch suite: 2\/2 passed/u)
  assert.match(stdout.value, /terminal-redrive suite: 2\/2 passed/u)
  assert.match(stdout.value, /removed and verified absent/u)
})

test('refuses a silent integration skip and still removes the exact container', async () => {
  const runtime = fakeRuntime({ skippedRecovery: true })
  await assert.rejects(
    runDisposableRedisIntegration({
      env: {
        npm_execpath: 'pnpm-cli.cjs',
        npm_lifecycle_event: 'test:redis:disposable',
      },
      spawnSyncImpl: runtime.spawnSyncImpl,
      waitImpl: async () => {},
      stdout: { write() {} },
      stderr: { write() {} },
      repositoryRoot: 'C:/pathfinder',
    }),
    /must execute exactly two passing, zero skipped or todo tests/u,
  )
  assert.equal(runtime.isRunning(), false)
})

test('bounds readiness failure and still removes the exact container', async () => {
  const runtime = fakeRuntime({ readinessNever: true })
  await assert.rejects(
    runDisposableRedisIntegration({
      env: {
        npm_execpath: 'pnpm-cli.cjs',
        npm_lifecycle_event: 'test:redis:disposable',
      },
      spawnSyncImpl: runtime.spawnSyncImpl,
      waitImpl: async () => {},
      stdout: { write() {} },
      stderr: { write() {} },
      repositoryRoot: 'C:/pathfinder',
    }),
    /did not become ready/u,
  )
  assert.equal(runtime.calls.filter(({ args }) => args[0] === 'exec').length, 40)
  assert.equal(runtime.isRunning(), false)
})

test('propagates Docker start failure after verified no-residue cleanup', async () => {
  const runtime = fakeRuntime({ runFails: true })
  await assert.rejects(
    runDisposableRedisIntegration({
      env: {
        npm_execpath: 'pnpm-cli.cjs',
        npm_lifecycle_event: 'test:redis:disposable',
      },
      spawnSyncImpl: runtime.spawnSyncImpl,
      waitImpl: async () => {},
      stdout: { write() {} },
      stderr: { write() {} },
      repositoryRoot: 'C:/pathfinder',
    }),
    /container start failed/u,
  )
  assert.equal(runtime.isRunning(), false)
})

test('surfaces both a suite failure and cleanup failure as an aggregate', async () => {
  const runtime = fakeRuntime({ skippedRecovery: true, cleanupFails: true })
  await assert.rejects(
    runDisposableRedisIntegration({
      env: {
        npm_execpath: 'pnpm-cli.cjs',
        npm_lifecycle_event: 'test:redis:disposable',
      },
      spawnSyncImpl: runtime.spawnSyncImpl,
      waitImpl: async () => {},
      stdout: { write() {} },
      stderr: { write() {} },
      repositoryRoot: 'C:/pathfinder',
    }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 2)
      return true
    },
  )
  assert.equal(runtime.isRunning(), true)
})
