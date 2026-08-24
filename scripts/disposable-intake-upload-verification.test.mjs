import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import test from 'node:test'

import {
  DisposableIntakeVerificationExecutionError,
  DisposableIntakeVerificationRefusal,
  DISPOSABLE_INTAKE_IMAGES,
  buildShakedownChildEnv,
  parsePublishedPort,
  runDisposableGoldenVenueShakedown,
  runDisposableIntakeVerificationShakedown,
  validateLocalDockerEndpoint,
  validateVitestReport,
} from './lib/disposable-intake-upload-verification.mjs'

const resources = {
  databaseUrl:
    'postgresql://generated:generated@127.0.0.1:49151/pathfinder_disposable_intake_worker_abcdef123456',
  redisPort: 49_152,
  bucket: 'pathfinder-disposable-intake-abcdef123456',
  minioPort: 49_153,
  minioUser: 'generated-minio-user',
  minioPassword: 'generated-minio-password',
  clamavPort: 49_154,
  clerkSecret: 'generated-clerk-secret',
  clerkPublishable: 'generated-clerk-publishable',
}

function passingReport() {
  return JSON.stringify({
    success: true,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numSkippedTests: 0,
    numTodoTests: 0,
    numTotalTests: 1,
    testResults: [{ assertionResults: [{ status: 'passed' }] }],
  })
}

test('accepts only exact local Docker daemon and IPv4-loopback port evidence', () => {
  for (const image of Object.values(DISPOSABLE_INTAKE_IMAGES)) {
    assert.match(image, /^[a-z0-9./-]+@sha256:[a-f0-9]{64}$/u)
  }
  assert.equal(
    validateLocalDockerEndpoint('npipe:////./pipe/dockerDesktopLinuxEngine'),
    'npipe:////./pipe/dockerDesktopLinuxEngine',
  )
  assert.equal(
    validateLocalDockerEndpoint('unix:///var/run/docker.sock'),
    'unix:///var/run/docker.sock',
  )
  for (const endpoint of ['tcp://127.0.0.1:2375', 'ssh://remote', '']) {
    assert.throws(() => validateLocalDockerEndpoint(endpoint), DisposableIntakeVerificationRefusal)
  }
  assert.equal(parsePublishedPort('127.0.0.1:49152\n', 'Redis'), 49_152)
  for (const output of [
    '0.0.0.0:49152',
    '[::1]:49152',
    '127.0.0.1:0',
    '127.0.0.1:65536',
    '127.0.0.1:49152\n127.0.0.1:49153',
  ]) {
    assert.throws(
      () => parsePublishedPort(output, 'Redis'),
      DisposableIntakeVerificationExecutionError,
    )
  }
})

test('builds a provider-dark child environment without inherited credentials', () => {
  const child = buildShakedownChildEnv(
    {
      PATH: 'retained',
      NODE_OPTIONS: '--inspect',
      DATABASE_URL: 'postgresql://production.invalid/live',
      REDIS_URL: 'redis://production.invalid',
      CLERK_SECRET_KEY: 'inherited',
      OPENAI_API_KEY: 'inherited',
      GOOGLE_OAUTH_CLIENT_SECRET: 'inherited',
      STORAGE_SECRET_ACCESS_KEY: 'inherited',
      TURBO_TOKEN: 'inherited',
      RUN_SOMETHING_DB_INTEGRATION: '1',
    },
    resources,
  )
  assert.equal(child.PATH, 'retained')
  assert.equal(child.NODE_OPTIONS, undefined)
  assert.equal(child.OPENAI_API_KEY, undefined)
  assert.equal(child.GOOGLE_OAUTH_CLIENT_SECRET, undefined)
  assert.equal(child.TURBO_TOKEN, undefined)
  assert.equal(child.DATABASE_URL, resources.databaseUrl)
  assert.equal(child.REDIS_URL, 'redis://127.0.0.1:49152')
  assert.equal(child.STORAGE_SECRET_ACCESS_KEY, resources.minioPassword)
  assert.equal(child.CLAMAV_HOST, undefined)
  assert.equal(child.INTAKE_CLAMAV_HOST, '127.0.0.1')
  assert.equal(child.OUTBOUND_PROVIDER_WORKERS_ENABLED, 'false')
  assert.equal(child.CRM_BACKGROUND_WORKERS_ENABLED, 'false')
  assert.equal(child.RUN_SOMETHING_DB_INTEGRATION, undefined)
  assert.equal(child.RUN_INTAKE_UPLOAD_WORKER_DB_INTEGRATION, '1')
})

test('requires exact executed-test evidence and refuses a silent skip', () => {
  assert.deepEqual(validateVitestReport(passingReport()), { passed: 1 })
  for (const report of [
    'not-json',
    JSON.stringify({
      success: true,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 1,
      numSkippedTests: 1,
      numTodoTests: 0,
      numTotalTests: 1,
      testResults: [{ assertionResults: [{ status: 'pending' }] }],
    }),
    JSON.stringify({
      success: false,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 0,
      numSkippedTests: 0,
      numTodoTests: 0,
      numTotalTests: 1,
      testResults: [{ assertionResults: [{ status: 'failed' }] }],
    }),
  ]) {
    assert.throws(() => validateVitestReport(report), DisposableIntakeVerificationExecutionError)
  }
})

test('refuses before Docker inspection without the exact package lifecycle', async () => {
  let spawned = false
  await assert.rejects(
    runDisposableIntakeVerificationShakedown({
      env: { npm_execpath: 'pnpm-cli.cjs' },
      spawnSyncImpl() {
        spawned = true
        throw new Error('must not spawn')
      },
    }),
    DisposableIntakeVerificationRefusal,
  )
  assert.equal(spawned, false)
})

function fakeRuntime({ integrationFails = false, cleanupFails = false } = {}) {
  const running = new Set()
  const childEnvironments = []
  const calls = []
  return {
    calls,
    childEnvironments,
    running,
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options })
      assert.equal(options.shell, false)
      if (command === 'docker' && args[0] === 'context' && args[1] === 'show') {
        return { status: 0, stdout: 'desktop-linux\n', stderr: '' }
      }
      if (command === 'docker' && args[0] === 'context' && args[1] === 'inspect') {
        return {
          status: 0,
          stdout: '"npipe:////./pipe/dockerDesktopLinuxEngine"\n',
          stderr: '',
        }
      }
      if (command === 'docker') {
        assert.equal(options.env.DOCKER_HOST, 'npipe:////./pipe/dockerDesktopLinuxEngine')
      }
      if (command === 'docker' && args[0] === 'ps') {
        const filter = args[args.indexOf('--filter') + 1]
        const name = filter.slice('name=^/'.length, -1)
        return { status: 0, stdout: running.has(name) ? `${name}\n` : '', stderr: '' }
      }
      if (command === 'docker' && args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1]
        assert.match(
          name,
          /^pathfinder-disposable-(?:intake|golden)-(?:postgres|redis|minio|clamav)-[a-f0-9]{12}$/u,
        )
        running.add(name)
        return { status: 0, stdout: 'container-id\n', stderr: '' }
      }
      if (command === 'docker' && args[0] === 'port') {
        const internal = args[2]
        const port = {
          '5432/tcp': 49_151,
          '6379/tcp': 49_152,
          '9000/tcp': 49_153,
          '3310/tcp': 49_154,
        }[internal]
        return { status: 0, stdout: `127.0.0.1:${port}\n`, stderr: '' }
      }
      if (command === 'docker' && args[0] === 'exec') {
        return {
          status: 0,
          stdout: args.includes('redis-cli') ? 'PONG\n' : 'accepting connections\n',
          stderr: '',
        }
      }
      if (command === 'docker' && args[0] === 'inspect') {
        return { status: 0, stdout: '"healthy"\n', stderr: '' }
      }
      if (command === 'docker' && args[0] === 'rm') {
        const name = args.at(-1)
        if (cleanupFails) return { status: 1, stdout: '', stderr: 'cleanup failed' }
        running.delete(name)
        return { status: 0, stdout: `${name}\n`, stderr: '' }
      }
      if (
        command === process.execPath &&
        args.some((value) => value.endsWith('migrate-disposable-db.mjs'))
      ) {
        return { status: 0, stdout: 'migration passed\n', stderr: '' }
      }
      if (command === process.execPath && args.includes('vitest')) {
        childEnvironments.push(options.env)
        const outputPath = args[args.indexOf('--outputFile') + 1]
        writeFileSync(
          outputPath,
          integrationFails
            ? JSON.stringify({
                success: false,
                numPassedTests: 0,
                numFailedTests: 1,
                numPendingTests: 0,
                numSkippedTests: 0,
                numTodoTests: 0,
                numTotalTests: 1,
                testResults: [{ assertionResults: [{ status: 'failed' }] }],
              })
            : passingReport(),
        )
        return { status: integrationFails ? 1 : 0, stdout: '', stderr: '' }
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
    },
  }
}

test('runs all four services, isolates the child, and verifies exact cleanup', async () => {
  const runtime = fakeRuntime()
  const stdout = {
    value: '',
    write(value) {
      this.value += value
    },
  }
  await assert.doesNotReject(
    runDisposableIntakeVerificationShakedown({
      env: {
        npm_execpath: 'pnpm-cli.cjs',
        npm_lifecycle_event: 'test:intake-upload-verification:disposable',
        OPENAI_API_KEY: 'must-not-propagate',
      },
      spawnSyncImpl: runtime.spawnSyncImpl,
      fetchImpl: async () => ({ ok: true }),
      waitImpl: async () => {},
      stdout,
      repositoryRoot: 'C:/pathfinder',
    }),
  )
  assert.equal(runtime.running.size, 0)
  assert.equal(runtime.childEnvironments.length, 1)
  assert.equal(runtime.childEnvironments[0].OPENAI_API_KEY, undefined)
  assert.equal(runtime.childEnvironments[0].OUTBOUND_PROVIDER_WORKERS_ENABLED, 'false')
  assert.match(stdout.value, /"cleanup":"verified-absent"/u)
  assert.equal(runtime.calls.filter(({ args }) => args[0] === 'rm').length, 4)
})

test('runs the Golden Venue core lifecycle with an exact provider-dark integration contract', async () => {
  const runtime = fakeRuntime()
  const stdout = {
    value: '',
    write(value) {
      this.value += value
    },
  }
  await assert.doesNotReject(
    runDisposableGoldenVenueShakedown({
      env: {
        npm_execpath: 'pnpm-cli.cjs',
        npm_lifecycle_event: 'golden-venue:disposable',
        ANTHROPIC_API_KEY: 'must-not-propagate',
        OPENAI_API_KEY: 'must-not-propagate',
      },
      spawnSyncImpl: runtime.spawnSyncImpl,
      fetchImpl: async () => ({ ok: true }),
      waitImpl: async () => {},
      stdout,
      repositoryRoot: 'C:/pathfinder',
    }),
  )
  const integrationCall = runtime.calls.find(
    ({ command, args }) => command === process.execPath && args.includes('vitest'),
  )
  assert.ok(integrationCall)
  assert.ok(integrationCall.args.includes('packages/api'))
  assert.ok(integrationCall.args.includes('src/remote-onboarding-disposable.integration.test.ts'))
  assert.equal(runtime.childEnvironments[0].RUN_REMOTE_ONBOARDING_E2E_DB_INTEGRATION, '1')
  assert.equal(runtime.childEnvironments[0].ANTHROPIC_API_KEY, undefined)
  assert.equal(runtime.childEnvironments[0].OPENAI_API_KEY, 'provider-dark-not-a-credential')
  assert.equal(runtime.childEnvironments[0].VOICE_MODE_ENABLED, 'true')
  assert.match(
    stdout.value,
    /"action":"golden-venue\.core-lifecycle\.disposable-shakedown\.passed"/u,
  )
  assert.match(stdout.value, /"proofScope":\["client","venue","onboarding"/u)
  assert.match(stdout.value, /"guest-chat-grounded-provider-dark"/u)
  assert.match(stdout.value, /"voice-mode-provider-dark-lifecycle"/u)
  assert.match(stdout.value, /"voice-fallback-to-text-persisted"/u)
  assert.match(stdout.value, /"visitor-feedback-persisted"/u)
  assert.match(stdout.value, /"support-service-led-resolution"/u)
  assert.match(stdout.value, /"report-publish-read"/u)
  assert.match(stdout.value, /"routine-update-publish-read"/u)
  assert.match(stdout.value, /"offboarding-reviewed-export-ready"/u)
  assert.match(
    stdout.value,
    /"failureScope":\["provider-outage","voice-authorization-failure","rate-limit","bad-upload","duplicate-request","failed-worker","report-failure","ambiguous-provider-outcome"\]/u,
  )
  assert.match(stdout.value, /"proofMetrics":\{"expectedFixtureQuestions":4\}/u)
  assert.match(stdout.value, /"cleanup":"verified-absent"/u)
  assert.equal(runtime.running.size, 0)
})

test('removes every exact container when the integration fails', async () => {
  const runtime = fakeRuntime({ integrationFails: true })
  await assert.rejects(
    runDisposableIntakeVerificationShakedown({
      env: {
        npm_execpath: 'pnpm-cli.cjs',
        npm_lifecycle_event: 'test:intake-upload-verification:disposable',
      },
      spawnSyncImpl: runtime.spawnSyncImpl,
      fetchImpl: async () => ({ ok: true }),
      waitImpl: async () => {},
      stdout: { write() {} },
      repositoryRoot: 'C:/pathfinder',
    }),
    DisposableIntakeVerificationExecutionError,
  )
  assert.equal(runtime.running.size, 0)
})
