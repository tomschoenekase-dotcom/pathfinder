import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIRMATION = 'pathfinder_disposable_intake_upload_verification'
const CONTAINER_PATTERN =
  /^pathfinder-disposable-(?:intake|venuemedia|webresearch|golden|improvement|costs|publicinterest|attribution|retention|supporttriage|supportinfo|supknow|suppdone|suppkg|semanticupdate|approvalpolicy|convergence|guestread|agentbridge|releaseevidence|opsreadiness|custaccess|firstweek|founderconversation|foundertask|voicerecovery)-(?:postgres|redis|minio|clamav)-[a-f0-9]{12}$/u
const DATABASE_PATTERN =
  /^pathfinder_disposable_(?:intake_worker|venue_media|intake_website_research|golden_venue|agent_improvement|operating_cost|public_interest|answer_attribution|retention_preview|support_triage|support_information|support_knowledge|support_completion|support_package_draft|semantic_update|agent_approval_policy|content_convergence|native_guest_read|agent_bridge|release_evidence|operations_readiness|customer_access|first_week_learning|founder_conversation|founder_task|voice_recovery)_[a-f0-9]{12}$/u
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

export async function runDisposableVenueMediaDerivativeShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'venuemedia',
      databasePrefix: 'pathfinder_disposable_venue_media_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_VENUE_MEDIA_SHAKEDOWN',
      lifecycleEvent: 'test:venue-media-derivative:disposable',
      successAction: 'venue-media-derivative.controlled-delivery.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'immutable-versioned-source-read',
        'metadata-stripped-webp-derivative',
        'retained-byte-and-sha256-identity',
        'server-only-storage-locator',
        'same-origin-controlled-delivery',
        'immediate-rights-withdrawal-enforcement',
        'provider-dark-preview-scope',
      ],
      integration: {
        packageDirectory: 'apps/workers',
        testFile: 'src/venue-media-derivative.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_VENUE_MEDIA_DERIVATIVE_DB_INTEGRATION: '1',
          PATHFINDER_DISPOSABLE_VENUE_MEDIA_CONFIRMATION:
            'pathfinder_disposable_venue_media_derivative',
          INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'false',
        },
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
        'same-run-linked-rollback-evidence',
        'explicit-policy-violation-evidence',
        'confidence-prediction-outcome-pairs',
        'append-only-operational-trust-signals',
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

export async function runDisposableOperatingCostShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'costs',
      databasePrefix: 'pathfinder_disposable_operating_cost_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_OPERATING_COST_SHAKEDOWN',
      lifecycleEvent: 'test:operating-cost:disposable',
      successAction: 'operating-cost-evidence.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'platform-tenant-venue-scope',
        'idempotent-replay',
        'append-only-corrections',
        'concurrent-supersession-fence',
        'database-declared-intake-and-media-bytes',
        'complete-queue-snapshot-admission',
        'content-addressed-usage-replay',
        'append-only-quantity-evidence',
        'strict-audit-evidence',
        'no-dollar-invoice-price-threshold-or-service-effect',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/operating-cost-evidence-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_OPERATING_COST_DB_INTEGRATION: '1',
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

export async function runDisposablePublicInterestConversionShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'publicinterest',
      databasePrefix: 'pathfinder_disposable_public_interest_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_PUBLIC_INTEREST_SHAKEDOWN',
      lifecycleEvent: 'test:public-interest-conversion:disposable',
      successAction: 'public-interest.reviewed-prospect-conversion.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'provider-dark-public-intake',
        'human-platform-admin-conversion',
        'canonical-crm-action-reuse',
        'idempotent-replay',
        'duplicate-fail-closed',
        'append-only-conversion-evidence',
        'source-provenance-snapshot',
        'no-communication-price-customer-onboarding-or-billing-effect',
      ],
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/public-interest-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          PATHFINDER_PUBLIC_INTEREST_DISPOSABLE: '1',
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

export async function runDisposablePlatformReleaseEvidenceShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'releaseevidence',
      databasePrefix: 'pathfinder_disposable_release_evidence_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_RELEASE_EVIDENCE_SHAKEDOWN',
      lifecycleEvent: 'test:platform-release-evidence:disposable',
      successAction: 'platform-release-evidence.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'human-and-separately-capability-gated-machine-recording',
        'exact-operation-replay-and-content-deduplication',
        'append-only-release-history',
        'strict-audit-evidence',
        'founder-and-machine-readable-bounded-projection',
        'no-deployment-migration-customer-contact-or-billing-authority',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/platform-release-evidence-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_PLATFORM_RELEASE_EVIDENCE_DB_INTEGRATION: '1',
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

export async function runDisposableOperationsReadinessShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'opsreadiness',
      databasePrefix: 'pathfinder_disposable_operations_readiness_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_OPERATIONS_READINESS_SHAKEDOWN',
      lifecycleEvent: 'test:operations-readiness:disposable',
      successAction: 'operations-readiness.migration-parity.disposable-shakedown.passed',
      proofScope: [
        'fresh-189-migration-chain',
        'exact-latest-migration-parity',
        'fresh-provider-dark-worker-heartbeat',
        'fresh-read-only-object-storage-probe',
        'fresh-read-only-malware-scanner-probe',
        'no-provider-customer-billing-or-destructive-effect',
      ],
      integration: {
        packageDirectory: 'apps/workers',
        testFile: 'src/service-dependency-readiness.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_OPERATIONS_READINESS_DB_INTEGRATION: '1',
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

export async function runDisposableGuestAnswerAttributionShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'attribution',
      databasePrefix: 'pathfinder_disposable_answer_attribution_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_ANSWER_ATTRIBUTION_SHAKEDOWN',
      lifecycleEvent: 'test:guest-answer-attribution:disposable',
      successAction: 'guest-answer-attribution.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'exact-answer-and-source-hashes',
        'human-attributed-semantic-judgment',
        'segmentation-independent-reviewer-agreement',
        'default-off-machine-review-lifecycle',
        'single-provider-dispatch-fence',
        'pre-dispatch-recovery-post-dispatch-ambiguity',
        'human-machine-calibration-separation',
        'idempotent-replay',
        'strict-tenant-venue-turn-scope',
        'append-only-history',
        'strict-audit-evidence',
        'no-quality-threshold-or-release-effect',
        'no-knowledge-or-operational-mutation',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/guest-answer-attribution-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_GUEST_ANSWER_ATTRIBUTION_DB_INTEGRATION: '1',
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

export async function runDisposableRetentionDispositionPreviewShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'retention',
      databasePrefix: 'pathfinder_disposable_retention_preview_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_RETENTION_PREVIEW_SHAKEDOWN',
      lifecycleEvent: 'test:retention-disposition-preview:disposable',
      successAction: 'retention-disposition-preview.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'exact-full-client-database-counts',
        'strict-cross-tenant-isolation',
        'unclassified-model-coverage',
        'platform-unscoped-boundary',
        'external-artifact-boundary',
        'unresolved-policy-fail-closed',
        'no-delete-anonymize-revocation-or-approval-effect',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/retention-disposition-preview.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_RETENTION_DISPOSITION_PREVIEW_DB_INTEGRATION: '1',
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

export async function runDisposableSupportKnowledgeProposalShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'supknow',
      databasePrefix: 'pathfinder_disposable_support_knowledge_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_SUPPORT_KNOWLEDGE_SHAKEDOWN',
      lifecycleEvent: 'test:support-knowledge-proposal:disposable',
      successAction: 'support-knowledge-proposal.disposable-shakedown.passed',
      proofScope: [
        'exact-reviewed-request-version',
        'immutable-message-evidence',
        'idempotent-replay',
        'one-proposal-per-source-version',
        'machine-capability-lineage',
        'support-state-unchanged',
        'canonical-knowledge-unchanged',
        'source-tamper-rejected',
        'separate-human-review-remains-valid',
        'no-customer-contact',
        'no-publication',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/support-knowledge-proposal-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_SUPPORT_KNOWLEDGE_PROPOSAL_DB_INTEGRATION: '1',
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

export async function runDisposableCustomerAccessExecutionShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'custaccess',
      databasePrefix: 'pathfinder_disposable_customer_access_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_CUSTOMER_ACCESS_EXECUTION_SHAKEDOWN',
      lifecycleEvent: 'test:customer-access-execution:disposable',
      successAction: 'customer-access-execution.disposable-shakedown.passed',
      proofScope: [
        'exact-owner-authored-request',
        'human-approval-revalidated',
        'provider-start-committed-before-io',
        'provider-adapter-isolated',
        'ambiguous-outcome-fails-to-reconciliation',
        'idempotent-provider-reconciliation',
        'provider-evidence-confirmed',
        'no-local-membership-created',
        'tenant-and-venue-isolation',
        'audit-lifecycle-retained',
        'cleanup-verified-absent',
      ],
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/customer-access-execution-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_CUSTOMER_ACCESS_EXECUTION_DB_INTEGRATION: '1',
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

export async function runDisposableFirstWeekLearningShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'firstweek',
      databasePrefix: 'pathfinder_disposable_first_week_learning_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_FIRST_WEEK_LEARNING_SHAKEDOWN',
      lifecycleEvent: 'test:first-week-learning:disposable',
      successAction: 'first-week-learning.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'release-anchored-day-1-day-3-day-7-windows',
        'privacy-bounded-aggregate-snapshot',
        'quiet-no-action-suppression',
        'draft-only-without-recipient-provider-or-send',
        'idempotent-replay',
        'tenant-and-venue-isolation',
        'append-only-review-evidence',
        'strict-audit-evidence',
        'deduplicated-founder-control-room-event',
        'no-operational-event-delivery',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/first-week-account-reviews-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_FIRST_WEEK_LEARNING_DB_INTEGRATION: '1',
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

export async function runDisposableFounderConversationShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'founderconversation',
      databasePrefix: 'pathfinder_disposable_founder_conversation_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_FOUNDER_CONVERSATION_SHAKEDOWN',
      lifecycleEvent: 'test:founder-conversation:disposable',
      successAction: 'founder-conversation.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'platform-scoped-question-and-directive-evidence',
        'exact-operation-replay',
        'parameter-drift-rejected',
        'append-only-update-delete-truncate-protection',
        'strict-audit-without-prompt-copy',
        'bounded-history',
        'explicit-zero-authority-snapshot',
        'no-tenant-venue-agent-approval-event-delivery-contact-or-billing-effects',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/founder-operating-exchanges-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_FOUNDER_CONVERSATION_DB_INTEGRATION: '1',
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

export async function runDisposableFounderDirectiveTaskShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'foundertask',
      databasePrefix: 'pathfinder_disposable_founder_task_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_FOUNDER_DIRECTIVE_TASK_SHAKEDOWN',
      lifecycleEvent: 'test:founder-directive-task:disposable',
      successAction: 'founder-directive-task.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'exact-retained-founder-directive-source',
        'separate-platform-worker-proposal-capability',
        'human-approval-before-task-materialization',
        'separate-materialization-capability',
        'canonical-agent-run-and-message-lineage',
        'proposal-and-materialization-idempotency',
        'parameter-drift-rejected',
        'immutable-proposal-and-no-delete-protection',
        'strict-audit-evidence',
        'no-customer-contact-pricing-billing-deployment-policy-or-destructive-authority',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/founder-directive-task-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_FOUNDER_DIRECTIVE_TASK_DB_INTEGRATION: '1',
          AGENT_RUNNER_ENABLED: 'false',
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
        'package-free-fulfillment-evidence-compatible',
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
        'approval-proposal-freezes-exact-package-handoff-and-evaluation-evidence',
        'founder-decision-issues-draft-to-approved-only-authority',
        'agent-executor-preserves-human-approver-and-agent-lineage',
        'approval-replay-converges-and-parameter-drift-fails-closed',
        'approved-package-remains-unapplied-unpublished-and-revertible',
        'application-proposal-and-founder-decision-mutate-no-content',
        'founder-gated-exact-approved-package-application',
        'agent-applied-current-content-with-full-lineage',
        'application-replay-converges-and-parameter-drift-fails-closed',
        'applied-content-is-current-and-may-be-visitor-visible',
        'application-does-not-complete-support-contact-customer-deliver-or-revert',
        'rollback-run-single-attempt-ceiling',
        'rollback-run-zero-cost-ceiling',
        'paid-provider-reservation-refused-before-dispatch',
        'founder-gated-canonical-rollback-with-exact-zero-cost-lineage',
        'post-rollback-second-attempt-refused',
        'completion-rejected-before-linked-package-application',
        'exact-applied-package-fulfillment-frozen-for-founder-review',
        'founder-gated-client-completion-after-application',
        'completion-replay-converges-without-duplicate-contact',
        'one-client-message-and-completed-request-after-application',
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

export async function runDisposableSemanticVenueUpdateShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'semanticupdate',
      databasePrefix: 'pathfinder_disposable_semantic_update_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_SEMANTIC_UPDATE_SHAKEDOWN',
      lifecycleEvent: 'test:semantic-venue-update:disposable',
      successAction: 'semantic-venue-update.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'exact-tenant-venue-proposal-package-scope',
        'one-proposal-to-one-reviewable-draft',
        'duplicate-handoff-rejected',
        'cross-scope-handoff-rejected',
        'append-only-update-delete-truncate-guards',
        'draft-only-without-approval-apply-or-publication',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/knowledge-proposal-package-handoff-disposable.integration.test.ts',
        expectedPassed: 2,
        environment: {
          RUN_KNOWLEDGE_PROPOSAL_PACKAGE_HANDOFF_DB_INTEGRATION: '1',
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

export async function runDisposableIntakeWebsiteResearchShakedown(options = {}) {
  return runDisposableServiceShakedown({
    ...options,
    configuration: {
      resourceFamily: 'webresearch',
      databasePrefix: 'pathfinder_disposable_intake_website_research_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_INTAKE_WEBSITE_RESEARCH_SHAKEDOWN',
      lifecycleEvent: 'test:intake-website-research:disposable',
      successAction: 'intake-website-research.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'tenant-venue-run-scope',
        'retry-lineage',
        'exact-terminal-replay',
        'append-only-receipts',
        'evidence-provenance',
        'no-package-or-publication-authority',
      ],
      failureScope: ['retry-after-success', 'receipt-update-rejected'],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/intake-website-research-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_INTAKE_WEBSITE_RESEARCH_DB_INTEGRATION: '1',
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
        'bounded-policy-expiry-refusal',
        'bounded-policy-use-exhaustion',
        'human-stop-revocation',
        'revoked-policy-no-artifact',
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
