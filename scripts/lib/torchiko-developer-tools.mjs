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
    tools: [...names].sort().map((name) => ({
      name,
      family: name.startsWith('pathfinder.') ? 'operational-mcp' : 'prospect-agent',
      source: name.startsWith('pathfinder.')
        ? 'packages/contracts/src/mcp-v0.ts'
        : 'packages/api/src/prospect-agent/registry.ts',
    })),
  }
}

export async function listFixtures(root) {
  const files = await walk(root, {
    include: (relative) => relative.includes('/dev-fixtures/') && /page\.tsx$/u.test(relative),
    descend: (_relative, name) => !['node_modules', '.git', '.next', 'dist'].includes(name),
  })
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
