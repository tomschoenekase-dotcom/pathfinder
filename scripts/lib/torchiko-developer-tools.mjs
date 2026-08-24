import { readdir, readFile, access, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

import { assessSyntheticConversationResponse } from './synthetic-conversation-assessment.mjs'
import ts from 'typescript'

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

function safeOperationalToolBindings(source) {
  const start = source.indexOf('export const SAFE_OPERATIONAL_MCP_TOOL_BINDINGS')
  const end = source.indexOf('] as const', start)
  if (start < 0 || end < 0) return new Set()
  return new Set(
    [...source.slice(start, end).matchAll(/'((?:pathfinder|torchiko)\.[a-z0-9_.]+)'/gu)].map(
      (match) => match[1],
    ),
  )
}

function mcpToolMetadata(source, runtimeBindings) {
  const start = source.indexOf('export const PATHFINDER_MCP_TOOLS')
  if (start < 0) return []
  const catalog = source.slice(start)
  return [...catalog.matchAll(/name:\s*'((?:pathfinder|torchiko)\.[a-z0-9_.]+)'/gu)].map(
    (match) => {
      const next = catalog.indexOf('\n  {', match.index + 1)
      const block = catalog.slice(match.index, next < 0 ? undefined : next)
      const security = block.match(
        /security\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,?\s*\)/u,
      )
      return {
        name: match[1],
        family: 'operational-mcp',
        capability: security?.[2] ?? 'unknown',
        scope: security?.[1] ?? 'unknown',
        effect: security?.[3] ?? 'unknown',
        approvalRequired: ['draft', 'bounded-evaluation-request'].includes(security?.[3]),
        idempotent: /idempotentHint:\s*true/u.test(block),
        defaultEnabled: !['draft', 'bounded-evaluation-request'].includes(security?.[3]),
        runtimeAvailability: runtimeBindings.has(match[1]) ? 'bound' : 'declared-unbound',
        transport: 'authenticated-agent-bridge',
        source: 'packages/contracts/src/mcp-v0.ts',
      }
    },
  )
}

function prospectToolMetadata(source, contracts) {
  const start = source.indexOf('export const PROSPECT_AGENT_TOOL_DEFINITIONS')
  const end = source.indexOf('] as const', start)
  if (start < 0 || end < 0) return []
  return [...source.slice(start, end).matchAll(/\{([\s\S]*?)\n\s*\},?/gu)]
    .map((match) => match[1])
    .filter((block) => /name:\s*'torchiko\.prospects\./u.test(block))
    .map((block) => {
      const name = block.match(/name:\s*'([^']+)'/u)?.[1]
      const contract = contracts.tools[name]
      return {
        name,
        family: 'prospect-agent',
        title: block.match(/title:\s*'([^']+)'/u)?.[1],
        capability: block.match(/capability:\s*'([^']+)'/u)?.[1],
        effect: block.match(/effect:\s*'([^']+)'/u)?.[1],
        approvalRequired: false,
        humanReviewRequired: /humanReviewRequired:\s*true/u.test(block),
        idempotent: /idempotent:\s*true/u.test(block),
        defaultEnabled: true,
        runtimeAvailability: 'bound',
        transport: 'authenticated-agent-bridge',
        source: 'packages/api/src/prospect-agent/registry.ts',
        inputSchema: contract?.inputSchema,
        outputSchema: contract?.outputSchema,
        examples: contract?.examples ?? [],
        relatedTools: contract?.relatedTools ?? [],
      }
    })
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
  const mcpTools = [
    ...mcpContract.matchAll(/name:\s*'((?:pathfinder|torchiko)\.[a-z0-9_.]+)'/gu),
  ].map((match) => match[1])
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
  const companyBrain = await buildCompanyBrainStatus(root)
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
    {
      id: 'company-brain',
      status: companyBrain.healthy ? 'pass' : 'fail',
      detail: companyBrain.healthy
        ? `${companyBrain.tools.required.length} tools and ${companyBrain.scenarios.count} scenarios`
        : 'Company Brain source, tool, or scenario validation failed',
    },
  ]
  const gates = [
    'OUTBOUND_PROVIDER_WORKERS_ENABLED',
    'CRM_BACKGROUND_WORKERS_ENABLED',
    'INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED',
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
  const [mcp, prospect, prospectContracts, composition] = await Promise.all([
    readFile(path.join(root, 'packages/contracts/src/mcp-v0.ts'), 'utf8'),
    readFile(path.join(root, 'packages/api/src/prospect-agent/registry.ts'), 'utf8'),
    readJson(path.join(root, 'packages/api/src/prospect-agent/tool-contracts.json')),
    readFile(path.join(root, 'packages/api/src/mcp/composition.ts'), 'utf8'),
  ])
  const runtimeBindings = safeOperationalToolBindings(composition)
  return {
    schemaVersion: 1,
    resources: mcpResourceNames(mcp).map((name) => ({
      name,
      family: 'operational-mcp-resource',
      source: 'packages/contracts/src/mcp-v0.ts',
    })),
    tools: [
      ...mcpToolMetadata(mcp, runtimeBindings),
      ...prospectToolMetadata(prospect, prospectContracts),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export function classifyRouter(routerName, policy) {
  return policy.categories.filter((category) => new RegExp(category.pattern, 'iu').test(routerName))
}

function moduleCandidates(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  return [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
}

async function resolveLocalModule(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null
  for (const candidate of moduleCandidates(fromFile, specifier)) {
    if (await exists(candidate)) return candidate
  }
  return null
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text
  }
  return null
}

function procedureKind(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null
  const terminal = node.expression.name.text
  return ['query', 'mutation', 'subscription'].includes(terminal) ? terminal : null
}

function exportedConst(sourceFile, symbol) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === symbol) {
        return declaration.initializer ?? null
      }
    }
  }
  return null
}

function importBindings(sourceFile) {
  const bindings = new Map()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const clause = statement.importClause
    if (!clause) continue
    if (clause.name) {
      bindings.set(clause.name.text, {
        imported: 'default',
        specifier: statement.moduleSpecifier.text,
      })
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, {
          imported: element.propertyName?.text ?? element.name.text,
          specifier: statement.moduleSpecifier.text,
        })
      }
    }
  }
  return bindings
}

async function buildStaticOperationInventory(root) {
  const sourceCache = new Map()
  const operations = []
  const unresolved = []
  const active = new Set()

  async function sourceFor(file) {
    if (!sourceCache.has(file)) {
      const source = await readFile(file, 'utf8')
      sourceCache.set(
        file,
        ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      )
    }
    return sourceCache.get(file)
  }

  async function visitSymbol(file, symbol, prefix, inheritedOwner = null) {
    const key = `${file}:${symbol}:${prefix}`
    if (active.has(key)) {
      unresolved.push({
        file: path.relative(root, file).replaceAll(path.sep, '/'),
        symbol,
        reason: 'cycle',
      })
      return
    }
    active.add(key)
    try {
      const sourceFile = await sourceFor(file)
      const initializer = exportedConst(sourceFile, symbol)
      if (!initializer) {
        unresolved.push({
          file: path.relative(root, file).replaceAll(path.sep, '/'),
          symbol,
          reason: 'missing-exported-const',
        })
        return
      }
      await visitExpression(file, sourceFile, initializer, prefix, inheritedOwner ?? symbol)
    } finally {
      active.delete(key)
    }
  }

  async function visitIdentifier(file, sourceFile, identifier, prefix, owner) {
    const binding = importBindings(sourceFile).get(identifier.text)
    if (binding) {
      const target = await resolveLocalModule(file, binding.specifier)
      if (!target) {
        unresolved.push({
          file: path.relative(root, file).replaceAll(path.sep, '/'),
          symbol: identifier.text,
          reason: 'unresolved-import',
        })
        return
      }
      await visitSymbol(target, binding.imported, prefix, null)
      return
    }
    await visitSymbol(file, identifier.text, prefix, owner)
  }

  async function visitExpression(file, sourceFile, expression, prefix, owner) {
    if (ts.isIdentifier(expression)) {
      await visitIdentifier(file, sourceFile, expression, prefix, owner)
      return
    }
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
      unresolved.push({
        file: path.relative(root, file).replaceAll(path.sep, '/'),
        symbol: owner,
        reason: 'unsupported-router-expression',
      })
      return
    }
    const factory = expression.expression.text
    if (factory === 'mergeRouters') {
      for (const argument of expression.arguments) {
        if (ts.isIdentifier(argument)) {
          await visitIdentifier(file, sourceFile, argument, prefix, owner)
        } else {
          unresolved.push({
            file: path.relative(root, file).replaceAll(path.sep, '/'),
            symbol: owner,
            reason: 'unsupported-merge-argument',
          })
        }
      }
      return
    }
    if (factory !== 'router' || !ts.isObjectLiteralExpression(expression.arguments[0])) {
      unresolved.push({
        file: path.relative(root, file).replaceAll(path.sep, '/'),
        symbol: owner,
        reason: 'unsupported-router-factory',
      })
      return
    }
    for (const property of expression.arguments[0].properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        unresolved.push({
          file: path.relative(root, file).replaceAll(path.sep, '/'),
          symbol: owner,
          reason: 'unsupported-router-property',
        })
        continue
      }
      const name = propertyName(property.name)
      if (!name) {
        unresolved.push({
          file: path.relative(root, file).replaceAll(path.sep, '/'),
          symbol: owner,
          reason: 'unsupported-router-key',
        })
        continue
      }
      const value = ts.isShorthandPropertyAssignment(property)
        ? property.name
        : property.initializer
      const kind = procedureKind(value)
      if (kind) {
        operations.push({
          path: `${prefix}${name}`,
          kind,
          router: owner,
          source: path.relative(root, file).replaceAll(path.sep, '/'),
        })
      } else {
        await visitExpression(file, sourceFile, value, `${prefix}${name}.`, owner)
      }
    }
  }

  await visitSymbol(path.join(root, 'packages/api/src/root.ts'), 'appRouter', '', 'appRouter')
  operations.sort((left, right) => left.path.localeCompare(right.path))
  return { operations, unresolved }
}

export function operationInventoryDigest(operations) {
  return createHash('sha256')
    .update(
      operations
        .map((operation) =>
          [operation.path, operation.kind, operation.router, operation.source].join('|'),
        )
        .join('\n'),
    )
    .digest('hex')
}

export function operationBindingDigest(bindings) {
  return createHash('sha256')
    .update(
      bindings
        .map((binding) =>
          [
            binding.path,
            binding.kind,
            binding.ruleId,
            binding.surfaces.join(','),
            binding.evidence,
          ].join('|'),
        )
        .join('\n'),
    )
    .digest('hex')
}

export function buildOperationBindings(operations, policy, toolCatalog) {
  const bindingPolicy = policy.operationBindings ?? {}
  const rules = bindingPolicy.rules ?? []
  const operationPaths = new Set(operations.map((operation) => operation.path))
  const knownSurfaces = new Set([
    ...toolCatalog.tools.map((tool) => `tool:${tool.name}`),
    ...toolCatalog.resources.map((resource) => `resource:${resource.name}`),
  ])
  const unavailableToolSurfaces = new Set(
    toolCatalog.tools
      .filter((tool) => tool.runtimeAvailability !== 'bound')
      .map((tool) => `tool:${tool.name}`),
  )
  const unknownOperations = []
  const unknownSurfaces = []
  const unavailableSurfaces = []
  const duplicateOperations = []
  const ruleByOperation = new Map()
  for (const rule of rules) {
    for (const surface of rule.surfaces ?? []) {
      if (!knownSurfaces.has(surface)) unknownSurfaces.push({ ruleId: rule.id, surface })
      else if (unavailableToolSurfaces.has(surface)) {
        unavailableSurfaces.push({ ruleId: rule.id, surface })
      }
    }
    for (const operation of rule.operations ?? []) {
      if (!operationPaths.has(operation)) {
        unknownOperations.push({ ruleId: rule.id, operation })
        continue
      }
      if (ruleByOperation.has(operation)) {
        duplicateOperations.push({
          operation,
          ruleIds: [ruleByOperation.get(operation).id, rule.id],
        })
        continue
      }
      ruleByOperation.set(operation, rule)
    }
  }
  const entries = operations.map((operation) => {
    const rule = ruleByOperation.get(operation.path)
    return {
      path: operation.path,
      kind: rule?.kind ?? 'unbound',
      ruleId: rule?.id ?? null,
      surfaces: [...(rule?.surfaces ?? [])].sort(),
      evidence: rule?.evidence ?? '',
      decision: rule?.decision ?? 'No concrete agent surface has been reviewed for this operation.',
    }
  })
  const digest = operationBindingDigest(entries)
  const reviewed = bindingPolicy.reviewed ?? {}
  const counts = entries.reduce((result, entry) => {
    result[entry.kind] = (result[entry.kind] ?? 0) + 1
    return result
  }, {})
  const validKinds = new Set(['direct-tool', 'bounded-alternative'])
  const invalidRules = rules
    .filter(
      (rule) =>
        !rule.id ||
        !validKinds.has(rule.kind) ||
        !Array.isArray(rule.operations) ||
        rule.operations.length === 0 ||
        !Array.isArray(rule.surfaces) ||
        rule.surfaces.length === 0 ||
        !rule.evidence ||
        !rule.decision,
    )
    .map((rule) => rule.id ?? null)
  const inventoryMatches = reviewed.operationInventorySha256 === policy.operationInventory?.sha256
  const digestMatches = reviewed.sha256 === digest
  return {
    counts,
    bound: entries.filter((entry) => entry.kind !== 'unbound').length,
    unbound: entries.filter((entry) => entry.kind === 'unbound').map((entry) => entry.path),
    entries,
    validation: {
      unknownOperations,
      unknownSurfaces,
      unavailableSurfaces,
      duplicateOperations,
      invalidRules,
      reviewedInventorySha256: reviewed.operationInventorySha256 ?? null,
      actualInventorySha256: policy.operationInventory?.sha256 ?? null,
      inventoryMatches,
      expectedSha256: reviewed.sha256 ?? null,
      actualSha256: digest,
      digestMatches,
    },
    healthy:
      unknownOperations.length === 0 &&
      unknownSurfaces.length === 0 &&
      unavailableSurfaces.length === 0 &&
      duplicateOperations.length === 0 &&
      invalidRules.length === 0 &&
      inventoryMatches &&
      digestMatches,
  }
}

export async function buildToolCoverageReport(root) {
  const [repository, policy, operationInventory, toolCatalog] = await Promise.all([
    buildRepositoryMap(root),
    readJson(path.join(root, 'scripts/agent-tool-coverage.json')),
    buildStaticOperationInventory(root),
    listAgentTools(root),
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
  const operationEntries = operationInventory.operations.map((operation) => {
    const matches = classifyRouter(operation.router, policy)
    return {
      ...operation,
      categories: matches.map((category) => category.id),
      agentCoverage: matches.length === 1 ? matches[0].agentCoverage : 'unreviewed',
      developerCoverage: matches.length === 1 ? matches[0].developerCoverage : 'unreviewed',
      status:
        matches.length === 1 ? 'classified' : matches.length === 0 ? 'unclassified' : 'ambiguous',
    }
  })
  const digest = operationInventoryDigest(operationInventory.operations)
  const operationBindings = buildOperationBindings(
    operationInventory.operations,
    policy,
    toolCatalog,
  )
  const reviewedInventory = policy.operationInventory ?? {}
  const inventoryMatches =
    reviewedInventory.count === operationEntries.length && reviewedInventory.sha256 === digest
  const operationCounts = operationEntries.reduce(
    (counts, operation) => {
      counts.byKind[operation.kind] = (counts.byKind[operation.kind] ?? 0) + 1
      counts.byAgentCoverage[operation.agentCoverage] =
        (counts.byAgentCoverage[operation.agentCoverage] ?? 0) + 1
      return counts
    },
    { byKind: {}, byAgentCoverage: {} },
  )
  const routerHealthy = entries.every((entry) => entry.status === 'classified')
  const operationsHealthy =
    operationInventory.unresolved.length === 0 &&
    operationEntries.every((entry) => entry.status === 'classified') &&
    inventoryMatches
  return {
    schemaVersion: 3,
    totalRouters: entries.length,
    classified: entries.filter((entry) => entry.status === 'classified').length,
    unclassified: entries
      .filter((entry) => entry.status === 'unclassified')
      .map((entry) => entry.router),
    ambiguous: entries.filter((entry) => entry.status === 'ambiguous'),
    categories: policy.categories,
    entries,
    operations: {
      total: operationEntries.length,
      classified: operationEntries.filter((entry) => entry.status === 'classified').length,
      unclassified: operationEntries.filter((entry) => entry.status === 'unclassified'),
      ambiguous: operationEntries.filter((entry) => entry.status === 'ambiguous'),
      unresolved: operationInventory.unresolved,
      reviewedInventory: {
        expectedCount: reviewedInventory.count ?? null,
        actualCount: operationEntries.length,
        expectedSha256: reviewedInventory.sha256 ?? null,
        actualSha256: digest,
        matches: inventoryMatches,
      },
      counts: operationCounts,
      entries: operationEntries,
      bindings: operationBindings,
      healthy: operationsHealthy,
    },
    healthy: routerHealthy && operationsHealthy && operationBindings.healthy,
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
    if (
      !Array.isArray(scenario.conversation?.expectedFacts) ||
      !scenario.conversation.expectedFacts.length
    )
      errors.push(`${scenario.id}: expected facts are required`)
    const assertionIds = new Set()
    for (const assertion of scenario.conversation?.expectedFacts ?? []) {
      if (!assertion?.id || assertionIds.has(assertion.id))
        errors.push(`${scenario.id}: expected fact ids must be present and unique`)
      assertionIds.add(assertion?.id)
      if (!assertion?.fact) errors.push(`${scenario.id}: expected fact label is required`)
      if (!Array.isArray(assertion?.matchTerms) || assertion.matchTerms.length === 0)
        errors.push(`${scenario.id}:${assertion?.id ?? 'unknown'}: match terms are required`)
      if (!Array.isArray(assertion?.evidenceRefs) || assertion.evidenceRefs.length === 0)
        errors.push(`${scenario.id}:${assertion?.id ?? 'unknown'}: evidence refs are required`)
      for (const reference of assertion?.evidenceRefs ?? []) {
        if (reference === 'weekly-hours') continue
        const locationId = reference.startsWith('location:')
          ? reference.slice('location:'.length)
          : null
        if (!locationId || !scenario.locations.some((location) => location.id === locationId))
          errors.push(
            `${scenario.id}:${assertion?.id ?? 'unknown'}: unknown evidence ref ${reference}`,
          )
      }
    }
  }
  return { ...registry, errors, healthy: errors.length === 0 }
}

export async function loadCompanyBrainScenarioRegistry(root) {
  const registry = await readJson(path.join(root, 'scripts/fixtures/company-brain-scenarios.json'))
  const errors = []
  if (registry.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (registry.synthetic !== true) errors.push('registry must be explicitly synthetic')
  const expected = new Set([
    'new-prospect',
    'converted-small-museum',
    'mature-multi-venue',
    'difficult-relationship',
    'friend-takeover',
  ])
  const ids = new Set()
  for (const scenario of registry.scenarios ?? []) {
    if (!scenario.id || ids.has(scenario.id)) errors.push('scenario ids must be present and unique')
    ids.add(scenario.id)
    if (!Array.isArray(scenario.entities) || scenario.entities.length === 0)
      errors.push(`${scenario.id}: entities are required`)
    if (!Array.isArray(scenario.assertions) || scenario.assertions.length === 0)
      errors.push(`${scenario.id}: assertions are required`)
    if (scenario.providerDispatch !== false)
      errors.push(`${scenario.id}: providerDispatch must be false by default`)
  }
  for (const id of expected) if (!ids.has(id)) errors.push(`missing required scenario: ${id}`)
  return { ...registry, errors, healthy: errors.length === 0 }
}

export async function buildCompanyBrainStatus(root) {
  const scenarios = await loadCompanyBrainScenarioRegistry(root)
  const required = [
    'packages/db/prisma/migrations/20260821190000_add_company_brain_crm_meetings/migration.sql',
    'packages/db/prisma/migrations/20260821193000_add_portable_agent_workers/migration.sql',
    'packages/db/prisma/migrations/20260821194500_add_company_knowledge_embeddings/migration.sql',
    'packages/db/prisma/migrations/20260821200000_sync_mcp_credential_capabilities/migration.sql',
    'packages/db/prisma/migrations/20260821201000_add_meeting_processing_capability/migration.sql',
    'packages/db/src/helpers/account-context.ts',
    'packages/db/src/helpers/company-knowledge.ts',
    'packages/db/src/helpers/company-meeting-actions.ts',
    'packages/api/src/mcp/company-brain-shakedown.disposable.integration.test.ts',
    'packages/api/src/lib/evaluation/company-brain-retrieval.ts',
    'packages/api/src/lib/evaluation/company-brain-scale.disposable.integration.test.ts',
    'packages/api/src/routers/admin/company-brain.ts',
    'apps/dashboard/app/(admin)/admin/company-brain/page.tsx',
  ]
  const checks = await Promise.all(
    required.map(async (file) => ({
      file,
      status: (await exists(path.join(root, file))) ? 'pass' : 'fail',
    })),
  )
  const tools = await listAgentTools(root)
  const requiredTools = [
    'torchiko.account.get_context',
    'torchiko.account.timeline',
    'torchiko.account.meetings',
    'torchiko.account.meeting_get',
    'torchiko.meeting.process',
    'torchiko.account.correspondence',
    'torchiko.knowledge.search',
    'torchiko.knowledge.get',
    'torchiko.integrations.health',
  ]
  const discovered = new Set(tools.tools.map((tool) => tool.name))
  const missingTools = requiredTools.filter((name) => !discovered.has(name))
  return {
    schemaVersion: 1,
    checks,
    tools: { required: requiredTools, missing: missingTools },
    scenarios: {
      count: scenarios.scenarios?.length ?? 0,
      healthy: scenarios.healthy,
      errors: scenarios.errors,
    },
    shakedown: {
      providerFree: true,
      databaseRequired: true,
      source: 'packages/api/src/mcp/company-brain-shakedown.disposable.integration.test.ts',
    },
    healthy:
      checks.every((check) => check.status === 'pass') &&
      missingTools.length === 0 &&
      scenarios.healthy,
  }
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
    assertions: scenario.conversation.expectedFacts.map((assertion) => ({
      id: assertion.id,
      fact: assertion.fact,
      required: true,
      matchTerms: assertion.matchTerms,
      evidence: assertion.evidenceRefs.map((reference) => {
        if (reference === 'weekly-hours')
          return {
            ref: reference,
            kind: 'scenario-weekly-hours',
            label: `Weekly hours for ${scenario.venue.timezone}`,
          }
        const location = scenario.locations.find(
          (candidate) => `location:${candidate.id}` === reference,
        )
        return {
          ref: reference,
          kind: 'scenario-location',
          label: location.name,
        }
      }),
    })),
    providerDispatch: false,
    note: 'Replay preparation is deterministic and does not call an AI provider.',
  }
}

export async function buildConversationAssessment(root, id, response) {
  return assessSyntheticConversationResponse(await buildConversationReplay(root, id), response)
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
