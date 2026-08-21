import { readdir, readFile, access, realpath } from 'node:fs/promises'
import path from 'node:path'

const TEST_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function walk(root, options = {}) {
  const { include = () => true, descend = () => true } = options
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).replaceAll(path.sep, '/')
      if (entry.isDirectory()) {
        if (descend(relative, entry.name)) await visit(absolute)
      } else if (entry.isFile() && include(relative, entry.name)) {
        files.push(relative)
      }
    }
  }
  await visit(root)
  return files.sort()
}

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'))
}

async function prismaClientState(root) {
  const client = path.join(root, 'packages/db/node_modules/@prisma/client')
  if (!(await exists(client))) return 'dependencies-uninstalled'
  const resolved = await realpath(client)
  const generated = path.resolve(resolved, '../..', '.prisma/client/default.d.ts')
  return (await exists(generated)) ? 'generated' : 'not-generated'
}

function importedNames(source, suffix) {
  return [
    ...source.matchAll(
      new RegExp(
        `import\\s+\\{?\\s*([A-Za-z0-9_]+)[^\\n]*from\\s+['\"][^'\"]+${suffix}['\"]`,
        'gu',
      ),
    ),
  ].map((match) => match[1])
}

function databaseTarget(value) {
  if (!value) return 'unset'
  try {
    const parsed = new URL(value)
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) ? 'loopback' : 'external'
  } catch {
    return 'invalid'
  }
}

function mcpResourceNames(source) {
  const start = source.indexOf('const resourceSeeds')
  const end = source.indexOf('export const McpResourceKind')
  if (start < 0 || end <= start) return []
  return [...source.slice(start, end).matchAll(/\[\s*'([a-z0-9-]+)',\s*'[^']+'/gu)].map(
    (match) => `pathfinder.${match[1]}`,
  )
}

export async function buildRepositoryMap(root) {
  const packageJson = await readJson(path.join(root, 'package.json'))
  const [files, rootRouter, adminRouter, mcpContract] = await Promise.all([
    walk(root, {
      include: (relative) =>
        SOURCE_EXTENSIONS.has(path.extname(relative)) || TEST_PATTERN.test(relative),
      descend: (_relative, name) =>
        !['node_modules', '.git', '.next', 'dist', 'coverage'].includes(name),
    }),
    readFile(path.join(root, 'packages/api/src/root.ts'), 'utf8'),
    readFile(path.join(root, 'packages/api/src/routers/admin/_admin.ts'), 'utf8'),
    readFile(path.join(root, 'packages/contracts/src/mcp-v0.ts'), 'utf8'),
  ])
  const tests = files.filter((file) => TEST_PATTERN.test(file))
  const workers = files.filter(
    (file) => file.startsWith('apps/workers/src/processors/') && !TEST_PATTERN.test(file),
  )
  const migrations = await readdir(path.join(root, 'packages/db/prisma/migrations'), {
    withFileTypes: true,
  })
  const mcpTools = [...mcpContract.matchAll(/name:\s*'(pathfinder\.[a-z0-9_]+)'/gu)].map(
    (match) => match[1],
  )
  return {
    schemaVersion: 1,
    repository: path.resolve(root),
    packageManager: packageJson.packageManager,
    entryPoints: {
      applicationRouters: importedNames(rootRouter, ''),
      adminRouters: importedNames(adminRouter, ''),
      workerProcessors: workers,
    },
    counts: {
      sourceFiles: files.length - tests.length,
      testFiles: tests.length,
      migrations: migrations.filter((entry) => entry.isDirectory()).length,
      mcpTools: new Set(mcpTools).size,
      mcpResources: mcpResourceNames(mcpContract).length,
    },
    canonicalSources: {
      api: 'packages/api/src/root.ts',
      adminApi: 'packages/api/src/routers/admin/_admin.ts',
      database: 'packages/db/prisma/schema.prisma',
      mcp: 'packages/contracts/src/mcp-v0.ts',
      jobs: 'packages/jobs/src',
      workers: 'apps/workers/src/processors',
      environment: 'packages/config/src/env.ts',
      publicSurface: 'packages/api/src/testing/public-surface-manifest.json',
    },
  }
}

export async function buildDoctorReport(root, environment = process.env) {
  const railwayEnvironment =
    environment.RAILWAY_ENVIRONMENT ||
    (environment.NODE_ENV === 'production' ? 'unset' : 'staging-default')
  const database = databaseTarget(environment.DATABASE_URL)
  const directDatabase = databaseTarget(environment.DIRECT_DATABASE_URL)
  const production = railwayEnvironment === 'production'
  const prismaClient = await prismaClientState(root)
  const checks = [
    {
      id: 'repository',
      status: (await exists(path.join(root, 'package.json'))) ? 'pass' : 'fail',
      detail: 'package.json is present',
    },
    {
      id: 'lockfile',
      status: (await exists(path.join(root, 'pnpm-lock.yaml'))) ? 'pass' : 'fail',
      detail: 'pnpm lockfile is present',
    },
    {
      id: 'node',
      status: Number(process.versions.node.split('.')[0]) >= 20 ? 'pass' : 'fail',
      detail: `Node ${process.versions.node}`,
    },
    {
      id: 'prisma-client',
      status:
        prismaClient === 'generated'
          ? 'pass'
          : prismaClient === 'dependencies-uninstalled'
            ? 'warn'
            : 'fail',
      detail: prismaClient,
    },
    {
      id: 'environment-identity',
      status: railwayEnvironment === 'unset' ? 'fail' : 'pass',
      detail: railwayEnvironment,
    },
    {
      id: 'database-target',
      status: database === 'invalid' ? 'fail' : database === 'unset' ? 'warn' : 'pass',
      detail: database,
    },
    {
      id: 'direct-database-target',
      status: directDatabase === 'invalid' ? 'fail' : directDatabase === 'unset' ? 'warn' : 'pass',
      detail: directDatabase,
    },
    {
      id: 'production-database',
      status: production && database !== 'external' ? 'fail' : 'pass',
      detail: production ? database : 'not-production',
    },
    {
      id: 'production-schedulers',
      status:
        production && !['true', 'false'].includes(environment.WORKER_SCHEDULERS_ENABLED)
          ? 'fail'
          : 'pass',
      detail: production ? environment.WORKER_SCHEDULERS_ENABLED || 'unset' : 'not-production',
    },
  ]
  const gates = [
    'OUTBOUND_PROVIDER_WORKERS_ENABLED',
    'CRM_BACKGROUND_WORKERS_ENABLED',
    'EVALUATION_RUNNER_ENABLED',
    'AGENT_RUNNER_ENABLED',
    'AGENT_BRIDGE_HTTP_ENABLED',
    'PROSPECT_OUTREACH_DELIVERY_ENABLED',
    'STRIPE_CHECKOUT_ENABLED',
    'STRIPE_CUSTOMER_PORTAL_ENABLED',
    'STRIPE_WEBHOOK_PROCESSING_ENABLED',
    'STRIPE_RECONCILIATION_ENABLED',
    'STRIPE_LIVE_MODE_ALLOWED',
  ].map((name) => ({ name, enabled: environment[name] === 'true' }))
  return {
    schemaVersion: 1,
    environment: {
      nodeEnv: environment.NODE_ENV || 'unset',
      railwayEnvironment,
      databaseTarget: database,
      directDatabaseTarget: directDatabase,
    },
    gates,
    checks,
    healthy: checks.every((check) => check.status !== 'fail'),
  }
}

export async function listAgentTools(root) {
  const [mcp, prospect] = await Promise.all([
    readFile(path.join(root, 'packages/contracts/src/mcp-v0.ts'), 'utf8'),
    readFile(path.join(root, 'packages/api/src/prospect-agent/registry.ts'), 'utf8'),
  ])
  const names = new Set([
    ...[...mcp.matchAll(/name:\s*'(pathfinder\.[a-z0-9_]+)'/gu)].map((match) => match[1]),
    ...[...prospect.matchAll(/'(torchiko\.prospects\.[a-z0-9_]+)'/gu)].map((match) => match[1]),
  ])
  return {
    schemaVersion: 1,
    resources: mcpResourceNames(mcp).map((name) => ({
      name,
      family: 'operational-mcp-resource',
      source: 'packages/contracts/src/mcp-v0.ts',
    })),
    tools: [...names].sort().map((name) => ({
      name,
      family: name.startsWith('pathfinder.') ? 'operational-mcp' : 'prospect-agent',
      source: name.startsWith('pathfinder.')
        ? 'packages/contracts/src/mcp-v0.ts'
        : 'packages/api/src/prospect-agent/registry.ts',
    })),
  }
}

export function classifyRouter(routerName, policy) {
  return policy.categories.filter((category) => new RegExp(category.pattern, 'iu').test(routerName))
}

export async function buildToolCoverageReport(root) {
  const [repository, policy] = await Promise.all([
    buildRepositoryMap(root),
    readJson(path.join(root, 'scripts/agent-tool-coverage.json')),
  ])
  const routers = [
    ...repository.entryPoints.applicationRouters,
    ...repository.entryPoints.adminRouters,
  ].filter((name) => /Router$/u.test(name))
  const entries = [...new Set(routers)].sort().map((router) => {
    const matches = classifyRouter(router, policy)
    return {
      router,
      categories: matches.map((category) => category.id),
      status:
        matches.length === 1 ? 'classified' : matches.length === 0 ? 'unclassified' : 'ambiguous',
    }
  })
  return {
    schemaVersion: 1,
    totalRouters: entries.length,
    classified: entries.filter((entry) => entry.status === 'classified').length,
    unclassified: entries
      .filter((entry) => entry.status === 'unclassified')
      .map((entry) => entry.router),
    ambiguous: entries.filter((entry) => entry.status === 'ambiguous'),
    categories: policy.categories,
    entries,
    healthy: entries.every((entry) => entry.status === 'classified'),
  }
}

export async function listFixtures(root) {
  const files = await walk(root, {
    include: (relative) => relative.includes('/dev-fixtures/') && /page\.tsx$/u.test(relative),
    descend: (_relative, name) => !['node_modules', '.git', '.next', 'dist'].includes(name),
  })
  const scenarioRegistry = await loadScenarioRegistry(root)
  return {
    schemaVersion: 1,
    visual: files.map((file) => {
      const appRelative = file.split('/app/')[1]
      return {
        file,
        route: `/${appRelative.replace(/(?:\/)?page\.tsx$/u, '').replace(/\/$/u, '')}`,
      }
    }),
    lifecycle: [
      {
        id: 'golden-venue-riverside-aquarium-v1',
        file: 'scripts/golden-venue/fixture.json',
        validate: 'pnpm golden-venue:validate',
      },
    ],
    scenarios: scenarioRegistry.scenarios.map((scenario) => ({
      id: scenario.id,
      venueType: scenario.venue.name,
      timezone: scenario.venue.timezone,
      source: 'scripts/fixtures/agent-scenarios.json',
    })),
  }
}

export async function loadScenarioRegistry(root) {
  const registry = await readJson(path.join(root, 'scripts/fixtures/agent-scenarios.json'))
  const errors = []
  if (registry.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (registry.synthetic !== true) errors.push('scenario registry must be explicitly synthetic')
  if (!Array.isArray(registry.scenarios) || registry.scenarios.length !== 4)
    errors.push('exactly four canonical scenarios are required')
  const ids = new Set()
  for (const scenario of registry.scenarios ?? []) {
    if (!scenario.id || ids.has(scenario.id)) errors.push('scenario ids must be present and unique')
    ids.add(scenario.id)
    if (!scenario.venue?.timezone) errors.push(`${scenario.id}: timezone is required`)
    if (!Array.isArray(scenario.locations) || scenario.locations.length === 0)
      errors.push(`${scenario.id}: at least one location is required`)
    for (const location of scenario.locations ?? []) {
      if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude))
        errors.push(`${scenario.id}: location coordinates must be finite`)
      if (!Number.isFinite(location.radiusMeters) || location.radiusMeters <= 0)
        errors.push(`${scenario.id}: location radius must be positive`)
    }
    if (!Array.isArray(scenario.conversation?.messages) || !scenario.conversation.messages.length)
      errors.push(`${scenario.id}: conversation messages are required`)
    if (!Array.isArray(scenario.conversation?.expectedFacts))
      errors.push(`${scenario.id}: expected facts are required`)
  }
  return { ...registry, errors, healthy: errors.length === 0 }
}

function getScenario(registry, id) {
  const scenario = registry.scenarios.find((candidate) => candidate.id === id)
  if (!scenario) throw new Error(`Unknown synthetic scenario: ${id}`)
  return scenario
}

export async function simulateScenarioTime(root, id, instant) {
  const registry = await loadScenarioRegistry(root)
  if (!registry.healthy) throw new Error('Synthetic scenario registry is invalid')
  const scenario = getScenario(registry, id)
  const parsed = new Date(instant)
  if (Number.isNaN(parsed.getTime())) throw new Error('Simulation instant must be ISO-8601')
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: scenario.venue.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(parsed)
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[
    local.find((part) => part.type === 'weekday')?.value
  ]
  const localTime = `${local.find((part) => part.type === 'hour')?.value}:${local.find((part) => part.type === 'minute')?.value}`
  const hours = scenario.weeklyHours[String(weekday)] ?? null
  return {
    schemaVersion: 1,
    synthetic: true,
    scenarioId: id,
    instant: parsed.toISOString(),
    timezone: scenario.venue.timezone,
    localTime,
    hours,
    open: Boolean(hours && localTime >= hours[0] && localTime < hours[1]),
  }
}

function distanceMeters(a, b) {
  const radians = (value) => (value * Math.PI) / 180
  const latitudeDelta = radians(b.latitude - a.latitude)
  const longitudeDelta = radians(b.longitude - a.longitude)
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

export async function simulateScenarioLocation(root, id, latitude, longitude) {
  const registry = await loadScenarioRegistry(root)
  if (!registry.healthy) throw new Error('Synthetic scenario registry is invalid')
  if (![latitude, longitude].every(Number.isFinite)) throw new Error('Coordinates must be finite')
  const scenario = getScenario(registry, id)
  const matches = scenario.locations
    .map((location) => {
      const distance = distanceMeters({ latitude, longitude }, location)
      return {
        id: location.id,
        name: location.name,
        distanceMeters: Math.round(distance),
        inside: distance <= location.radiusMeters,
      }
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
  return { schemaVersion: 1, synthetic: true, scenarioId: id, matches }
}

export async function buildConversationReplay(root, id) {
  const registry = await loadScenarioRegistry(root)
  if (!registry.healthy) throw new Error('Synthetic scenario registry is invalid')
  const scenario = getScenario(registry, id)
  return {
    schemaVersion: 1,
    synthetic: true,
    scenarioId: id,
    venue: scenario.venue,
    messages: scenario.conversation.messages,
    assertions: scenario.conversation.expectedFacts.map((fact) => ({ fact, required: true })),
    providerDispatch: false,
    note: 'Replay preparation is deterministic and does not call an AI provider.',
  }
}

export async function findTests(root, query) {
  const normalized = query.toLowerCase()
  const tests = await walk(root, {
    include: (relative) => TEST_PATTERN.test(relative),
    descend: (_relative, name) =>
      !['node_modules', '.git', '.next', 'dist', 'coverage'].includes(name),
  })
  const matches = tests.filter((file) => file.toLowerCase().includes(normalized)).slice(0, 100)
  return { schemaVersion: 1, query, matches, truncated: matches.length === 100 }
}

export async function buildBootstrapReport(root, environment = process.env) {
  const doctor = await buildDoctorReport(root, environment)
  return {
    schemaVersion: 1,
    safeToContinue: doctor.healthy,
    environment: doctor.environment,
    nextCommands: [
      'pnpm install --frozen-lockfile',
      'pnpm --filter @pathfinder/db db:generate',
      'pnpm torchiko doctor --json',
      'pnpm torchiko repo map --json',
      'pnpm golden-venue:validate',
      'pnpm typecheck',
    ],
    note: 'Bootstrap is inspect-only. Database migration, seeding, providers, schedulers, outreach, and billing remain explicit operations.',
  }
}
