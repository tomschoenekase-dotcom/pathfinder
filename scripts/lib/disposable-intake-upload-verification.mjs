import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIRMATION = 'pathfinder_disposable_intake_upload_verification'
const CONTAINER_PATTERN =
  /^pathfinder-disposable-(?:intake|golden|improvement|supporttriage|supportinfo|suppdone|suppkg|approvalpolicy|convergence|guestread|agentbridge)-(?:postgres|redis|minio|clamav)-[a-f0-9]{12}$/u
const DATABASE_PATTERN =
  /^pathfinder_disposable_(?:intake_worker|golden_venue|agent_improvement|support_triage|support_information|support_completion|support_package_draft|agent_approval_policy|content_convergence|native_guest_read|agent_bridge)_[a-f0-9]{12}$/u
const GOLDEN_VENUE_FIXTURE = JSON.parse(
  readFileSync(new URL('../golden-venue/fixture.json', import.meta.url), 'utf8'),
)
export const DISPOSABLE_INTAKE_IMAGES = Object.freeze({
  postgres:
    'pgvector/pgvector@sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b',
  redis: 'redis@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2',
  minio: 'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
  clamav: 'clamav/clamav@sha256:78810772a92b4a9168115bc6b2e0ffd702640893b9577f8c3d0432762d2655c4',
})

export class DisposableIntakeVerificationRefusal extends Error {}
export class DisposableIntakeVerificationExecutionError extends Error {}

function refuse(message) {
  throw new DisposableIntakeVerificationRefusal(message)
}

function fail(message) {
  throw new DisposableIntakeVerificationExecutionError(message)
}

function runNative(spawnSyncImpl, command, args, options = {}) {
  return spawnSyncImpl(command, args, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30_000,
    ...options,
  })
}

function assertStarted(result, action) {
  if (result.error || typeof result.status !== 'number') fail(`${action} could not be started`)
  if (result.status !== 0) fail(`${action} failed`)
}

function deleteCaseInsensitive(environment, names) {
  const lowered = new Set(names.map((name) => name.toLowerCase()))
  for (const key of Object.keys(environment)) {
    if (lowered.has(key.toLowerCase())) delete environment[key]
  }
}

export function validateLocalDockerEndpoint(rawEndpoint) {
  if (typeof rawEndpoint !== 'string' || rawEndpoint.length === 0) {
    refuse('Docker context has no daemon endpoint')
  }
  if (!rawEndpoint.startsWith('npipe://') && !rawEndpoint.startsWith('unix://')) {
    refuse('Disposable intake verification requires a local npipe or Unix-socket Docker daemon')
  }
  return rawEndpoint
}

function initializeDockerRuntime(parentEnv, spawnSyncImpl) {
  const inheritedDockerHost = Object.entries(parentEnv).find(
    ([key, value]) => key.toLowerCase() === 'docker_host' && String(value).length > 0,
  )
  if (inheritedDockerHost) refuse('Unset DOCKER_HOST before running the disposable shakedown')

  const discoveryEnv = { ...parentEnv }
  deleteCaseInsensitive(discoveryEnv, ['DOCKER_HOST'])
  const shown = runNative(spawnSyncImpl, 'docker', ['context', 'show'], {
    env: discoveryEnv,
    timeout: 15_000,
  })
  assertStarted(shown, 'Docker context discovery')
  const contextName = String(shown.stdout).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(contextName)) {
    refuse('Docker context name is invalid')
  }
  const inspected = runNative(
    spawnSyncImpl,
    'docker',
    ['context', 'inspect', contextName, '--format', '{{json .Endpoints.docker.Host}}'],
    { env: discoveryEnv, timeout: 15_000 },
  )
  assertStarted(inspected, 'Docker context inspection')
  let endpoint
  try {
    endpoint = JSON.parse(String(inspected.stdout).trim())
  } catch {
    refuse('Docker context endpoint could not be parsed')
  }
  validateLocalDockerEndpoint(endpoint)

  const pinnedEnv = { ...parentEnv }
  deleteCaseInsensitive(pinnedEnv, [
    'DOCKER_CERT_PATH',
    'DOCKER_CONTEXT',
    'DOCKER_HOST',
    'DOCKER_TLS_VERIFY',
  ])
  pinnedEnv.DOCKER_HOST = endpoint
  return { contextName, endpoint, env: pinnedEnv }
}

function runDocker(spawnSyncImpl, runtime, args, options = {}) {
  return runNative(spawnSyncImpl, 'docker', args, { env: runtime.env, ...options })
}

export function parsePublishedPort(output, service) {
  const lines = String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length !== 1) fail(`Docker must publish exactly one ${service} loopback port`)
  const match = /^127\.0\.0\.1:([0-9]{1,5})$/u.exec(lines[0])
  if (!match) fail(`Docker ${service} port must be published on exact IPv4 loopback`)
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(`Docker returned an invalid ${service} port`)
  }
  return port
}

function exactContainerNames(spawnSyncImpl, runtime, containerName) {
  const result = runDocker(spawnSyncImpl, runtime, [
    'ps',
    '--all',
    '--filter',
    `name=^/${containerName}$`,
    '--format',
    '{{.Names}}',
  ])
  assertStarted(result, 'Docker container inspection')
  return String(result.stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

function removeExactContainer(spawnSyncImpl, runtime, containerName) {
  if (!CONTAINER_PATTERN.test(containerName)) refuse('Disposable container identity is invalid')
  const names = exactContainerNames(spawnSyncImpl, runtime, containerName)
  if (names.length > 1 || (names.length === 1 && names[0] !== containerName)) {
    refuse('Docker returned an ambiguous disposable container identity')
  }
  if (names.length === 1) {
    const removal = runDocker(spawnSyncImpl, runtime, ['rm', '--force', '--volumes', containerName])
    assertStarted(removal, 'Disposable container cleanup')
  }
  if (exactContainerNames(spawnSyncImpl, runtime, containerName).length !== 0) {
    fail('Disposable container still exists after cleanup')
  }
}

async function waitFor({ description, probe, waitImpl, attempts = 120, delayMs = 500 }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await probe()) return
    await waitImpl(delayMs)
  }
  fail(`${description} did not become ready`)
}

function containerHealth(spawnSyncImpl, runtime, containerName) {
  const result = runDocker(
    spawnSyncImpl,
    runtime,
    ['inspect', '--format', '{{json .State.Health.Status}}', containerName],
    { timeout: 5_000 },
  )
  if (result.status !== 0) return ''
  try {
    return JSON.parse(String(result.stdout).trim())
  } catch {
    return ''
  }
}

function startContainer(spawnSyncImpl, runtime, args, action) {
  const result = runDocker(spawnSyncImpl, runtime, ['run', '--rm', '--detach', ...args], {
    timeout: 300_000,
  })
  assertStarted(result, action)
}

function publishedPort(spawnSyncImpl, runtime, containerName, containerPort, service) {
  const result = runDocker(spawnSyncImpl, runtime, ['port', containerName, `${containerPort}/tcp`])
  assertStarted(result, `${service} port inspection`)
  return parsePublishedPort(result.stdout, service)
}

function randomCredential(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`
}

export function buildShakedownChildEnv(parentEnv, resources) {
  const child = {}
  for (const [key, value] of Object.entries(parentEnv)) {
    const lower = key.toLowerCase()
    if (
      lower === 'node_options' ||
      lower === 'node_path' ||
      lower.startsWith('docker_') ||
      lower.startsWith('turbo_') ||
      /(?:secret|token|password|api[_-]?key|access[_-]?key|encryption[_-]?key|credential|cookie|session|oauth|private[_-]?key)/iu.test(
        key,
      ) ||
      /^(?:database_url|direct_database_url|redis_url|storage_|intake_clamav_|clerk_|stripe_|google_|gmail_|aws_|azure_|anthropic_|openai_|resend_)/iu.test(
        key,
      ) ||
      /^run_.*integration$/iu.test(key) ||
      lower === 'pathfinder_disposable_intake_confirmation'
    ) {
      continue
    }
    child[key] = value
  }
  Object.assign(child, {
    NODE_ENV: 'test',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    RAILWAY_ENVIRONMENT: 'preview',
    DATABASE_URL: resources.databaseUrl,
    DIRECT_DATABASE_URL: resources.databaseUrl,
    REDIS_URL: `redis://127.0.0.1:${resources.redisPort}`,
    STORAGE_BUCKET: resources.bucket,
    STORAGE_REGION: 'us-east-1',
    STORAGE_ENDPOINT: `http://127.0.0.1:${resources.minioPort}`,
    STORAGE_ACCESS_KEY_ID: resources.minioUser,
    STORAGE_SECRET_ACCESS_KEY: resources.minioPassword,
    INTAKE_CLAMAV_HOST: '127.0.0.1',
    INTAKE_CLAMAV_PORT: String(resources.clamavPort),
    CLERK_SECRET_KEY: resources.clerkSecret,
    CLERK_PUBLISHABLE_KEY: resources.clerkPublishable,
    RUN_INTAKE_UPLOAD_WORKER_DB_INTEGRATION: '1',
    PATHFINDER_DISPOSABLE_INTAKE_CONFIRMATION: CONFIRMATION,
    OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
    CRM_BACKGROUND_WORKERS_ENABLED: 'false',
    INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'true',
    WORKER_SCHEDULERS_ENABLED: 'false',
    PROSPECT_OUTREACH_DELIVERY_ENABLED: 'false',
    OPERATIONAL_ALERT_DELIVERY_ENABLED: 'false',
    STRIPE_MODE: 'test',
    STRIPE_LIVE_MODE_ALLOWED: 'false',
  })
  return child
}

export function validateVitestReport(output, expectedPassed = 1) {
  let report
  try {
    report = JSON.parse(String(output))
  } catch {
    fail('Shakedown did not return a machine-readable Vitest report')
  }
  const assertions = report.testResults?.flatMap((result) => result.assertionResults ?? []) ?? []
  if (
    report.success !== true ||
    report.numPassedTests !== expectedPassed ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    (report.numSkippedTests ?? 0) !== 0 ||
    report.numTodoTests !== 0 ||
    report.numTotalTests !== expectedPassed ||
    assertions.length !== expectedPassed ||
    assertions.some((assertion) => assertion.status !== 'passed')
  ) {
    fail(
      `Shakedown must execute exactly ${expectedPassed} passing, zero skipped or todo integration tests`,
    )
  }
  return { passed: expectedPassed }
}

function redact(value, sensitiveTokens) {
  let redacted = String(value)
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/giu, '[REDACTED_DATABASE_URL]')
    .replace(/(?:redis|https?):\/\/[^\s"'`]+/giu, '[REDACTED_SERVICE_URL]')
  for (const token of [...sensitiveTokens].sort((left, right) => right.length - left.length)) {
    if (!token) continue
    redacted = redacted.split(token).join('[REDACTED]')
  }
  return redacted
}

function runMigration({
  env,
  database,
  databaseUrl,
  repositoryRoot,
  spawnSyncImpl,
  sensitiveTokens,
}) {
  const migrationEnv = buildShakedownChildEnv(env, {
    databaseUrl,
    redisPort: 1,
    bucket: 'unused',
    minioPort: 1,
    minioUser: 'unused',
    minioPassword: 'unused',
    clamavPort: 1,
    clerkSecret: 'unused',
    clerkPublishable: 'unused',
  })
  migrationEnv.PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS = '1'
  migrationEnv.PATHFINDER_DISPOSABLE_DATABASE_URL = databaseUrl
  const result = runNative(
    spawnSyncImpl,
    process.execPath,
    [
      resolve(repositoryRoot, 'scripts', 'migrate-disposable-db.mjs'),
      '--database',
      database,
      '--confirm-database',
      database,
    ],
    { cwd: repositoryRoot, env: migrationEnv, timeout: 300_000 },
  )
  if (result.error || typeof result.status !== 'number')
    fail('Disposable migration could not start')
  if (result.status !== 0) {
    const detail = redact(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, sensitiveTokens)
    fail(`Disposable migration failed. ${detail.slice(-4_000)}`)
  }
}

function runIntegration({
  env,
  resources,
  repositoryRoot,
  packageManagerCli,
  reportPath,
  spawnSyncImpl,
  sensitiveTokens,
  integration,
}) {
  const childEnv = buildShakedownChildEnv(env, resources)
  Object.assign(childEnv, integration.environment)
  const result = runNative(
    spawnSyncImpl,
    process.execPath,
    [
      packageManagerCli,
      '--dir',
      integration.packageDirectory,
      'exec',
      'vitest',
      'run',
      integration.testFile,
      '--pool=forks',
      '--maxWorkers=1',
      '--reporter=json',
      '--outputFile',
      reportPath,
    ],
    { cwd: repositoryRoot, env: childEnv, timeout: 300_000 },
  )
  if (result.error || typeof result.status !== 'number') fail('Shakedown test could not start')
  if (result.status !== 0) {
    let reportFailure = ''
    if (existsSync(reportPath)) {
      try {
        const report = JSON.parse(readFileSync(reportPath, 'utf8'))
        reportFailure = (report.testResults ?? [])
          .flatMap((testResult) => [
            testResult.message,
            ...(testResult.assertionResults ?? []).flatMap(
              (assertion) => assertion.failureMessages ?? [],
            ),
          ])
          .filter(Boolean)
          .join('\n')
      } catch {
        reportFailure = 'Machine-readable failure report could not be parsed.'
      }
    }
    const detail = redact(
      `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${reportFailure}`,
      sensitiveTokens,
    )
    fail(`Shakedown test failed. ${detail.slice(-8_000)}`)
  }
  return validateVitestReport(readFileSync(reportPath, 'utf8'), integration.expectedPassed)
}

export async function runDisposableServiceShakedown({
  env = process.env,
  spawnSyncImpl = spawnSync,
  fetchImpl = fetch,
  waitImpl = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  stdout = process.stdout,
  repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url))),
  configuration,
} = {}) {
  const packageManagerCli = env.npm_execpath
  if (!packageManagerCli) refuse('Run this shakedown through pnpm')
  if (
    env[configuration.optInEnvironmentKey] !== '1' &&
    env.npm_lifecycle_event !== configuration.lifecycleEvent
  ) {
    refuse(`Use the ${configuration.lifecycleEvent} package lifecycle or its exact opt-in`)
  }
  const runtime = initializeDockerRuntime(env, spawnSyncImpl)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = {
    postgres: `pathfinder-disposable-${configuration.resourceFamily}-postgres-${suffix}`,
    redis: `pathfinder-disposable-${configuration.resourceFamily}-redis-${suffix}`,
    minio: `pathfinder-disposable-${configuration.resourceFamily}-minio-${suffix}`,
    clamav: `pathfinder-disposable-${configuration.resourceFamily}-clamav-${suffix}`,
  }
  const database = `${configuration.databasePrefix}${suffix}`
  if (
    !DATABASE_PATTERN.test(database) ||
    Object.values(names).some((name) => !CONTAINER_PATTERN.test(name))
  ) {
    refuse('Generated disposable resource identity is invalid')
  }
  const postgresUser = `intake_${suffix}`
  const postgresPassword = randomCredential('pg')
  const minioUser = randomCredential('minio_user').slice(0, 48)
  const minioPassword = randomCredential('minio_password')
  const clerkSecret = randomCredential('clerk_secret')
  const clerkPublishable = randomCredential('clerk_publishable')
  const bucket = `pathfinder-disposable-intake-${suffix}`
  const sensitiveTokens = [
    postgresUser,
    postgresPassword,
    minioUser,
    minioPassword,
    clerkSecret,
    clerkPublishable,
  ]
  const reportDirectory = mkdtempSync(join(tmpdir(), 'pathfinder-intake-shakedown-'))
  const reportPath = join(reportDirectory, 'vitest.json')
  let primaryError
  let result

  try {
    for (const name of Object.values(names)) {
      if (exactContainerNames(spawnSyncImpl, runtime, name).length !== 0) {
        refuse('Generated disposable container identity already exists')
      }
    }
    startContainer(
      spawnSyncImpl,
      runtime,
      [
        '--name',
        names.postgres,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        `POSTGRES_DB=${database}`,
        '--env',
        `POSTGRES_USER=${postgresUser}`,
        '--env',
        `POSTGRES_PASSWORD=${postgresPassword}`,
        '--tmpfs',
        '/var/lib/postgresql/data',
        DISPOSABLE_INTAKE_IMAGES.postgres,
      ],
      'Disposable PostgreSQL start',
    )
    startContainer(
      spawnSyncImpl,
      runtime,
      ['--name', names.redis, '--publish', '127.0.0.1::6379', DISPOSABLE_INTAKE_IMAGES.redis],
      'Disposable Redis start',
    )
    startContainer(
      spawnSyncImpl,
      runtime,
      [
        '--name',
        names.minio,
        '--publish',
        '127.0.0.1::9000',
        '--env',
        `MINIO_ROOT_USER=${minioUser}`,
        '--env',
        `MINIO_ROOT_PASSWORD=${minioPassword}`,
        '--tmpfs',
        '/data',
        DISPOSABLE_INTAKE_IMAGES.minio,
        'server',
        '/data',
        '--address',
        ':9000',
      ],
      'Disposable MinIO start',
    )
    startContainer(
      spawnSyncImpl,
      runtime,
      ['--name', names.clamav, '--publish', '127.0.0.1::3310', DISPOSABLE_INTAKE_IMAGES.clamav],
      'Disposable ClamAV start',
    )

    const postgresPort = publishedPort(spawnSyncImpl, runtime, names.postgres, 5432, 'PostgreSQL')
    const redisPort = publishedPort(spawnSyncImpl, runtime, names.redis, 6379, 'Redis')
    const minioPort = publishedPort(spawnSyncImpl, runtime, names.minio, 9000, 'MinIO')
    const clamavPort = publishedPort(spawnSyncImpl, runtime, names.clamav, 3310, 'ClamAV')

    await waitFor({
      description: 'Disposable PostgreSQL',
      waitImpl,
      probe: async () => {
        const check = runDocker(
          spawnSyncImpl,
          runtime,
          ['exec', names.postgres, 'pg_isready', '--username', postgresUser, '--dbname', database],
          { timeout: 5_000 },
        )
        return check.status === 0
      },
    })
    await waitFor({
      description: 'Disposable Redis',
      waitImpl,
      probe: async () => {
        const check = runDocker(
          spawnSyncImpl,
          runtime,
          ['exec', names.redis, 'redis-cli', 'ping'],
          { timeout: 5_000 },
        )
        return check.status === 0 && String(check.stdout).trim() === 'PONG'
      },
    })
    await waitFor({
      description: 'Disposable MinIO',
      waitImpl,
      probe: async () => {
        try {
          const response = await fetchImpl(`http://127.0.0.1:${minioPort}/minio/health/live`)
          return response.ok
        } catch {
          return false
        }
      },
    })
    await waitFor({
      description: 'Disposable ClamAV',
      waitImpl,
      attempts: 360,
      probe: async () => containerHealth(spawnSyncImpl, runtime, names.clamav) === 'healthy',
    })

    const databaseUrl = `postgresql://${encodeURIComponent(postgresUser)}:${encodeURIComponent(postgresPassword)}@127.0.0.1:${postgresPort}/${database}`
    sensitiveTokens.push(databaseUrl)
    runMigration({
      env,
      database,
      databaseUrl,
      repositoryRoot,
      spawnSyncImpl,
      sensitiveTokens,
    })
    result = runIntegration({
      env,
      resources: {
        databaseUrl,
        redisPort,
        bucket,
        minioPort,
        minioUser,
        minioPassword,
        clamavPort,
        clerkSecret,
        clerkPublishable,
      },
      repositoryRoot,
      packageManagerCli,
      reportPath,
      spawnSyncImpl,
      sensitiveTokens,
      integration: configuration.integration,
    })
  } catch (error) {
    primaryError = error
  }

  const cleanupErrors = []
  for (const name of Object.values(names).reverse()) {
    try {
      removeExactContainer(spawnSyncImpl, runtime, name)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  rmSync(reportDirectory, { recursive: true, force: true })
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], 'Shakedown and cleanup failed')
  }
  if (primaryError) throw primaryError
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Shakedown cleanup failed')

  stdout.write(
    `${JSON.stringify({
      action: configuration.successAction,
      testsPassed: result.passed,
      services: ['postgresql', 'redis', 'minio', 'clamav'],
      outboundProviderWorkersEnabled: false,
      ...(configuration.proofScope ? { proofScope: configuration.proofScope } : {}),
      ...(configuration.failureScope ? { failureScope: configuration.failureScope } : {}),
      ...(configuration.proofMetrics ? { proofMetrics: configuration.proofMetrics } : {}),
      cleanup: 'verified-absent',
    })}\n`,
  )
  return 0
}

export async function runDisposableIntakeVerificationShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'intake',
      databasePrefix: 'pathfinder_disposable_intake_worker_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_INTAKE_SHAKEDOWN',
      lifecycleEvent: 'test:intake-upload-verification:disposable',
      successAction: 'intake-upload-verification.disposable-shakedown.passed',
      integration: {
        packageDirectory: 'apps/workers',
        testFile: 'src/intake-upload-verification.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {},
      },
    },
  })
}

export async function runDisposableGoldenVenueShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'golden',
      databasePrefix: 'pathfinder_disposable_golden_venue_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_GOLDEN_VENUE_SHAKEDOWN',
      lifecycleEvent: 'golden-venue:disposable',
      successAction: 'golden-venue.core-lifecycle.disposable-shakedown.passed',
      proofScope: [
        'client',
        'venue',
        'onboarding',
        'upload-intake',
        'review',
        'content-package-eval',
        'release-rollback',
        'guest-chat-grounded-provider-dark',
        'voice-mode-provider-dark-lifecycle',
        'voice-fallback-to-text-persisted',
        'visitor-feedback-persisted',
        'support-handoff',
        'support-service-led-resolution',
        'report-publish-read',
        'routine-update-publish-read',
        'offboarding-reviewed-export-ready',
      ],
      failureScope: [
        'provider-outage',
        'voice-authorization-failure',
        'rate-limit',
        'bad-upload',
        'duplicate-request',
        'failed-worker',
        'report-failure',
        'ambiguous-provider-outcome',
      ],
      proofMetrics: {
        expectedFixtureQuestions: GOLDEN_VENUE_FIXTURE.expectedQuestions.length,
      },
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/remote-onboarding-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_REMOTE_ONBOARDING_E2E_DB_INTEGRATION: '1',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          CRM_BACKGROUND_WORKERS_ENABLED: 'false',
          INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
          PROSPECT_OUTREACH_DELIVERY_ENABLED: 'false',
          OPERATIONAL_ALERT_DELIVERY_ENABLED: 'false',
          STRIPE_MODE: 'test',
          STRIPE_LIVE_MODE_ALLOWED: 'false',
          VOICE_MODE_ENABLED: 'true',
          OPENAI_API_KEY: 'provider-dark-not-a-credential',
        },
      },
    },
  })
}

export async function runDisposableAgentImprovementShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'improvement',
      databasePrefix: 'pathfinder_disposable_agent_improvement_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_AGENT_IMPROVEMENT_SHAKEDOWN',
      lifecycleEvent: 'test:agent-improvement:disposable',
      successAction: 'agent-improvement.validation-loop.disposable-shakedown.passed',
      proofScope: [
        'exact-outcome-evidence',
        'versioned-improvement-hypothesis',
        'human-review-only-approval',
        'no-agent-authority-mutation',
        'append-only-proposal-evidence',
        'immutable-implementation-reference',
        'same-corpus-before-after-evaluation',
        'declared-change-only-comparability',
        'no-automatic-promotion',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/agent-improvement-proposal-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_AGENT_IMPROVEMENT_DB_INTEGRATION: '1',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          CRM_BACKGROUND_WORKERS_ENABLED: 'false',
          INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
          PROSPECT_OUTREACH_DELIVERY_ENABLED: 'false',
          OPERATIONAL_ALERT_DELIVERY_ENABLED: 'false',
          STRIPE_MODE: 'test',
          STRIPE_LIVE_MODE_ALLOWED: 'false',
        },
      },
    },
  })
}

export async function runDisposableSupportTriageApplicationShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'supporttriage',
      databasePrefix: 'pathfinder_disposable_support_triage_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_SUPPORT_TRIAGE_SHAKEDOWN',
      lifecycleEvent: 'test:support-triage-application:disposable',
      successAction: 'support-triage-application.disposable-shakedown.passed',
      proofScope: [
        'exact-request-version',
        'evidence-backed-recommendation',
        'idempotent-replay',
        'human-approval-before-authority',
        'exact-one-shot-grant',
        'approved-triage-only',
        'optimistic-version-enforcement',
        'client-version-single-increment',
        'no-status-change',
        'no-participant-grant',
        'no-message',
        'no-customer-contact',
        'no-package-execution',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/support-triage-proposal-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_SUPPORT_TRIAGE_PROPOSAL_DB_INTEGRATION: '1',
          RUN_SUPPORT_TRIAGE_APPLICATION_DB_INTEGRATION: '1',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          CRM_BACKGROUND_WORKERS_ENABLED: 'false',
          INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
          PROSPECT_OUTREACH_DELIVERY_ENABLED: 'false',
          OPERATIONAL_ALERT_DELIVERY_ENABLED: 'false',
          STRIPE_MODE: 'test',
          STRIPE_LIVE_MODE_ALLOWED: 'false',
        },
      },
    },
  })
}

export const runDisposableSupportTriageProposalShakedown =
  runDisposableSupportTriageApplicationShakedown

export async function runDisposableSupportInformationRequestShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'supportinfo',
      databasePrefix: 'pathfinder_disposable_support_information_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_SUPPORT_INFORMATION_SHAKEDOWN',
      lifecycleEvent: 'test:support-information-request:disposable',
      successAction: 'support-information-request.disposable-shakedown.passed',
      proofScope: [
        'proposal-has-no-client-effect',
        'exact-request-version-and-status',
        'unchanged-triage-checklist',
        'founder-approval-before-authority',
        'exact-one-shot-grant',
        'one-client-visible-in-app-message',
        'waiting-for-client-transition',
        'idempotent-replay-without-duplicate-contact',
        'parameter-drift-rejected',
        'no-external-delivery',
        'no-participant-change',
        'no-package-execution',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/support-information-request-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_SUPPORT_INFORMATION_REQUEST_DB_INTEGRATION: '1',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          CRM_BACKGROUND_WORKERS_ENABLED: 'false',
          INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
          PROSPECT_OUTREACH_DELIVERY_ENABLED: 'false',
          OPERATIONAL_ALERT_DELIVERY_ENABLED: 'false',
          STRIPE_MODE: 'test',
          STRIPE_LIVE_MODE_ALLOWED: 'false',
        },
      },
    },
  })
}

export async function runDisposableSupportCompletionShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'suppdone',
      databasePrefix: 'pathfinder_disposable_support_completion_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_SUPPORT_COMPLETION_SHAKEDOWN',
      lifecycleEvent: 'test:support-completion:disposable',
      successAction: 'support-completion.disposable-shakedown.passed',
      proofScope: [
        'proposal-has-no-client-effect',
        'exact-request-version-and-status',
        'resolved-information-required',
        'founder-approval-before-authority',
        'exact-one-shot-grant',
        'one-client-visible-in-app-message',
        'completed-transition',
        'idempotent-replay-without-duplicate-contact',
        'parameter-drift-rejected',
        'no-external-delivery',
        'no-participant-change',
        'no-package-execution',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/support-completion-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_SUPPORT_COMPLETION_DB_INTEGRATION: '1',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          CRM_BACKGROUND_WORKERS_ENABLED: 'false',
          INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
          PROSPECT_OUTREACH_DELIVERY_ENABLED: 'false',
          OPERATIONAL_ALERT_DELIVERY_ENABLED: 'false',
          STRIPE_MODE: 'test',
          STRIPE_LIVE_MODE_ALLOWED: 'false',
        },
      },
    },
  })
}

export async function runDisposableSupportPackageDraftShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'suppkg',
      databasePrefix: 'pathfinder_disposable_support_package_draft_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_SUPPORT_PACKAGE_DRAFT_SHAKEDOWN',
      lifecycleEvent: 'test:support-package-draft:disposable',
      successAction: 'support-package-draft.disposable-shakedown.passed',
      proofScope: [
        'proposal-has-no-operational-effect',
        'exact-v3-payload-and-operation-counts',
        'founder-approval-before-authority',
        'exact-one-shot-grant',
        'canonical-package-draft-service',
        'atomic-support-request-linkage',
        'agent-attribution-and-lineage',
        'idempotent-replay-without-duplicate-draft-or-handoff',
        'parameter-drift-rejected',
        'draft-only-without-approval-apply-publish-or-rollback',
        'support-linked-draft-preview-and-evaluation-snapshot',
        'evaluation-does-not-approve-apply-publish-contact-or-spend',
        'no-client-message-participant-or-version-effect',
        'no-external-delivery',
      ],
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/support-package-draft-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_SUPPORT_PACKAGE_DRAFT_DB_INTEGRATION: '1',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          CRM_BACKGROUND_WORKERS_ENABLED: 'false',
          INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
          PROSPECT_OUTREACH_DELIVERY_ENABLED: 'false',
          OPERATIONAL_ALERT_DELIVERY_ENABLED: 'false',
          STRIPE_MODE: 'test',
          STRIPE_LIVE_MODE_ALLOWED: 'false',
        },
      },
    },
  })
}

export async function runDisposableAgentApprovalPolicyShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'approvalpolicy',
      databasePrefix: 'pathfinder_disposable_agent_approval_policy_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_AGENT_APPROVAL_POLICY_SHAKEDOWN',
      lifecycleEvent: 'test:agent-approval-policy:disposable',
      successAction: 'agent-approval-policy.disposable-shakedown.passed',
      proofScope: [
        'human-issued-policy-only',
        'tenant-venue-agent-action-capability-scope',
        'exact-scope-authority-outcome-membership',
        'idempotent-policy-issuance',
        'registered-draft-only-constraint-evaluator',
        'private-support-draft-lifecycle',
        'approval-bound-one-use-support-draft-opening',
        'approval-bound-one-use-internal-support-note',
        'support-note-no-client-activity-or-customer-contact',
        'notes-only-intake-proposal-lineage',
        'intake-review-boundary-no-package-or-publication',
        'weekly-report-draft-generation-lineage',
        'weekly-report-no-publication-or-delivery',
        'policy-consumption-machine-lineage',
        'parameter-boundary-rejection',
        'one-shot-approval-compatibility',
        'no-publication-or-customer-contact',
      ],
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/mcp/company-brain-shakedown.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_COMPANY_BRAIN_DB_INTEGRATION: '1',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          CRM_BACKGROUND_WORKERS_ENABLED: 'false',
          INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
          PROSPECT_OUTREACH_DELIVERY_ENABLED: 'false',
          OPERATIONAL_ALERT_DELIVERY_ENABLED: 'false',
          STRIPE_MODE: 'test',
          STRIPE_LIVE_MODE_ALLOWED: 'false',
        },
      },
    },
  })
}
