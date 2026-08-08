import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONTAINER_NAME_PATTERN = /^pathfinder-disposable-redis-[a-z0-9-]+$/u

export class DisposableRedisRefusal extends Error {}
export class DisposableRedisExecutionError extends Error {}

function refuse(message) {
  throw new DisposableRedisRefusal(message)
}

function fail(message) {
  throw new DisposableRedisExecutionError(message)
}

export function parsePublishedRedisPort(output) {
  const lines = String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length !== 1) fail('Docker must publish exactly one Redis loopback port')
  const match = /^127\.0\.0\.1:([0-9]{1,5})$/u.exec(lines[0])
  if (!match) fail('Docker Redis port must be published on exact IPv4 loopback')
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail('Docker returned an invalid Redis port')
  }
  return port
}

export function buildDisposableRedisChildEnv(parentEnv, port, suite) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) refuse('Redis port is invalid')
  if (suite !== 'recovery' && suite !== 'dispatch') refuse('Redis suite is invalid')
  const childEnv = {}
  for (const [key, value] of Object.entries(parentEnv)) {
    const lowerKey = key.toLowerCase()
    if (lowerKey === 'node_options' || lowerKey === 'node_path') continue
    if (lowerKey === 'no_color' || lowerKey === 'force_color') continue
    if (lowerKey === 'redis_url' || lowerKey === 'railway_environment') continue
    if (lowerKey === 'turbo_team' || lowerKey === 'turbo_token') continue
    if (lowerKey === 'database_url' || lowerKey === 'direct_database_url') continue
    if (/(?:secret|token|password|api_key|access_key|encryption_key|credential)/iu.test(key)) {
      continue
    }
    if (
      /^(?:run_generation_.*_redis_integration|pathfinder_disposable_redis_confirmation)$/iu.test(
        key,
      )
    ) {
      continue
    }
    childEnv[key] = value
  }
  childEnv.REDIS_URL = `redis://127.0.0.1:${port}`
  childEnv.RAILWAY_ENVIRONMENT = 'preview'
  childEnv.NO_COLOR = '1'
  childEnv.FORCE_COLOR = '0'
  if (suite === 'recovery') {
    childEnv.RUN_GENERATION_RECOVERY_REDIS_INTEGRATION = '1'
    childEnv.PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION = 'pathfinder_disposable_generation_recovery'
  } else {
    childEnv.RUN_GENERATION_DISPATCH_REDIS_INTEGRATION = '1'
    childEnv.PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION = 'pathfinder_disposable_generation_dispatch'
  }
  return childEnv
}

export function validateVitestJsonReport(output, suite) {
  let report
  try {
    report = JSON.parse(String(output))
  } catch {
    fail(`${suite} suite did not return a machine-readable Vitest report`)
  }
  if (
    report.success !== true ||
    report.numPassedTests !== 2 ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    (report.numSkippedTests ?? 0) !== 0 ||
    report.numTodoTests !== 0 ||
    report.numTotalTests !== 2 ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== 1 ||
    !Array.isArray(report.testResults[0]?.assertionResults) ||
    report.testResults[0].assertionResults.length !== 2 ||
    report.testResults[0].assertionResults.some((assertion) => assertion.status !== 'passed')
  ) {
    fail(`${suite} suite must execute exactly two passing, zero skipped or todo tests`)
  }
  return { passed: report.numPassedTests }
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
    refuse('Disposable Redis requires a local npipe or Unix-socket Docker daemon')
  }
  return rawEndpoint
}

function initializeDockerRuntime(parentEnv, spawnSyncImpl) {
  const inheritedDockerHost = Object.entries(parentEnv).find(
    ([key, value]) => key.toLowerCase() === 'docker_host' && String(value).length > 0,
  )
  if (inheritedDockerHost) refuse('Unset DOCKER_HOST before running the disposable Redis gate')

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

async function waitForRedis({ containerName, dockerRuntime, spawnSyncImpl, waitImpl }) {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const result = runDocker(
      spawnSyncImpl,
      dockerRuntime,
      ['exec', containerName, 'redis-cli', 'ping'],
      { timeout: 5_000 },
    )
    if (result.status === 0 && String(result.stdout).trim() === 'PONG') return
    await waitImpl(250)
  }
  fail('Disposable Redis did not become ready')
}

function exactContainerNames(spawnSyncImpl, dockerRuntime, containerName) {
  const result = runDocker(spawnSyncImpl, dockerRuntime, [
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

function removeExactContainer(spawnSyncImpl, dockerRuntime, containerName) {
  const names = exactContainerNames(spawnSyncImpl, dockerRuntime, containerName)
  if (names.length > 1 || (names.length === 1 && names[0] !== containerName)) {
    refuse('Docker returned an ambiguous disposable Redis container identity')
  }
  if (names.length === 1) {
    const removal = runDocker(spawnSyncImpl, dockerRuntime, ['rm', '--force', containerName])
    assertStarted(removal, 'Disposable Redis cleanup')
  }
  if (exactContainerNames(spawnSyncImpl, dockerRuntime, containerName).length !== 0) {
    fail('Disposable Redis container still exists after cleanup')
  }
}

function runSuite({
  suite,
  port,
  repositoryRoot,
  packageManagerCli,
  parentEnv,
  spawnSyncImpl,
  stdout,
  stderr,
}) {
  const file =
    suite === 'recovery'
      ? 'src/generation-recovery.integration.test.ts'
      : 'src/generation-dispatch.integration.test.ts'
  const result = runNative(
    spawnSyncImpl,
    process.execPath,
    [
      packageManagerCli,
      '--dir',
      'packages/jobs',
      'exec',
      'vitest',
      'run',
      file,
      '--pool=forks',
      '--maxWorkers=1',
      '--reporter=json',
    ],
    {
      cwd: repositoryRoot,
      env: buildDisposableRedisChildEnv(parentEnv, port, suite),
      timeout: 120_000,
    },
  )
  if (result.stderr) stderr.write(result.stderr)
  if (result.error || typeof result.status !== 'number') fail(`${suite} suite could not start`)
  if (result.status !== 0) {
    if (result.stdout) stdout.write(result.stdout)
    fail(`${suite} suite failed`)
  }
  const report = validateVitestJsonReport(result.stdout, suite)
  stdout.write(`Disposable Redis ${suite} suite: ${report.passed}/2 passed.\n`)
}

export async function runDisposableRedisIntegration({
  env = process.env,
  spawnSyncImpl = spawnSync,
  waitImpl = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  stdout = process.stdout,
  stderr = process.stderr,
  repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url))),
} = {}) {
  const packageManagerCli = env.npm_execpath
  if (!packageManagerCli) refuse('Run this integration gate through pnpm')
  if (
    env.PATHFINDER_ALLOW_DISPOSABLE_REDIS !== '1' &&
    env.npm_lifecycle_event !== 'test:redis:disposable'
  ) {
    refuse('Set PATHFINDER_ALLOW_DISPOSABLE_REDIS=1 or use pnpm test:redis:disposable')
  }
  const dockerRuntime = initializeDockerRuntime(env, spawnSyncImpl)
  const containerName = `pathfinder-disposable-redis-${randomUUID()}`
  if (!CONTAINER_NAME_PATTERN.test(containerName)) refuse('Disposable Redis identity is invalid')
  let primaryError

  try {
    if (exactContainerNames(spawnSyncImpl, dockerRuntime, containerName).length !== 0) {
      refuse('Disposable Redis container identity already exists')
    }
    const started = runDocker(
      spawnSyncImpl,
      dockerRuntime,
      [
        'run',
        '--rm',
        '--name',
        containerName,
        '--detach',
        '--publish',
        '127.0.0.1::6379',
        'redis:7-alpine',
      ],
      { timeout: 120_000 },
    )
    assertStarted(started, 'Disposable Redis container start')
    await waitForRedis({ containerName, dockerRuntime, spawnSyncImpl, waitImpl })

    const published = runDocker(spawnSyncImpl, dockerRuntime, ['port', containerName, '6379/tcp'])
    assertStarted(published, 'Disposable Redis port inspection')
    const port = parsePublishedRedisPort(published.stdout)
    stdout.write(`Disposable Redis ready on exact loopback port ${port}.\n`)

    for (const suite of ['recovery', 'dispatch']) {
      runSuite({
        suite,
        port,
        repositoryRoot,
        packageManagerCli,
        parentEnv: env,
        spawnSyncImpl,
        stdout,
        stderr,
      })
    }
  } catch (error) {
    primaryError = error
  }

  let cleanupError
  try {
    removeExactContainer(spawnSyncImpl, dockerRuntime, containerName)
    stdout.write('Disposable Redis container removed and verified absent.\n')
  } catch (error) {
    cleanupError = error
  }

  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'Redis integration and cleanup both failed',
    )
  }
  if (cleanupError) throw cleanupError
  if (primaryError) throw primaryError
  return 0
}
