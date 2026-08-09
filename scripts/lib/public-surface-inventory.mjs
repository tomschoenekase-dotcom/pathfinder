import path from 'node:path'
import ts from 'typescript'

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const CONTROL_PROFILES = new Set([
  'static-public-liveness',
  'bounded-resource-read',
  'bounded-session-write',
  'bounded-sensitive-read',
  'bounded-ai-write',
  'bounded-telemetry-write',
  'procedure-controlled-transport',
  'middleware-and-procedure-controlled',
  'bounded-public-health',
  'bounded-widget-readiness',
  'bounded-signed-webhook',
  'handler-platform-admin',
])
const CANONICAL_PROCEDURE_BUILDERS = new Map([
  ['publicProcedure', 't.procedure'],
  ['publicAiProcedure', 'publicProcedure.use(requireGlobalAi)'],
  ['protectedProcedure', 't.procedure.use(requireAuth)'],
  ['tenantProcedure', 't.procedure.use(requireAuth).use(requireTenant)'],
  ['adminProcedure', 't.procedure.use(requireAuth).use(requirePlatformAdminMiddleware)'],
  ['adminAiProcedure', 'adminProcedure.use(requireGlobalAi)'],
])
const TRPC_PROFILE_POLICY = new Map([
  ['static-public-liveness', { exposure: 'public', kind: 'query' }],
  ['bounded-resource-read', { exposure: 'public', kind: 'query' }],
  ['bounded-sensitive-read', { exposure: 'public', kind: 'query' }],
  ['bounded-session-write', { exposure: 'public', kind: 'mutation' }],
  ['bounded-ai-write', { exposure: 'public-ai', kind: 'mutation' }],
  ['bounded-telemetry-write', { exposure: 'public', kind: 'mutation' }],
])
const HTTP_PROFILE_POLICY = new Map([
  ['procedure-controlled-transport', 'procedure-controlled-public-transport'],
  ['middleware-and-procedure-controlled', 'middleware-and-procedure-controlled'],
  ['bounded-public-health', 'intentional-public'],
  ['bounded-widget-readiness', 'intentional-public'],
  ['bounded-signed-webhook', 'signature-authenticated-public-ingress'],
  ['handler-platform-admin', 'handler-platform-admin'],
])
const TRPC_ENTRY_KEYS = new Set([
  'path',
  'kind',
  'exposure',
  'controlProfile',
  'behavioralEvidence',
  'exceptionReason',
])
const HTTP_ENTRY_KEYS = new Set([
  'source',
  'methods',
  'exposure',
  'controlProfile',
  'behavioralEvidence',
  'exceptionReason',
])

function normalizePath(value) {
  return value.replaceAll('\\', '/')
}

function unwrap(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function staticName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
  return null
}

function terminalKind(node) {
  const current = unwrap(node)
  if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) {
    return null
  }
  const name = current.expression.name.text
  return name === 'query' || name === 'mutation' || name === 'subscription' ? name : null
}

function hasExportModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function moduleRecord(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const variables = new Map()
  const imports = new Map()
  const violations = []

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text
          if (
            (imported === 'publicProcedure' || imported === 'publicAiProcedure') &&
            element.name.text !== imported
          ) {
            violations.push(
              `${fileName}: ${imported} must not be imported through alias '${element.name.text}'`,
            )
          }
          imports.set(element.name.text, {
            imported,
            specifier: statement.moduleSpecifier.text,
          })
        }
      }
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        variables.set(declaration.name.text, declaration.initializer)
      }
    }
  }

  return { sourceFile, variables, imports, violations }
}

function builderSignature(node) {
  const current = unwrap(node)
  if (ts.isIdentifier(current)) return current.text
  if (
    ts.isPropertyAccessExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === 't' &&
    current.name.text === 'procedure'
  ) {
    return 't.procedure'
  }
  if (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    current.expression.name.text === 'use' &&
    current.arguments.length === 1 &&
    ts.isIdentifier(current.arguments[0])
  ) {
    const base = builderSignature(current.expression.expression)
    return base ? `${base}.use(${current.arguments[0].text})` : null
  }
  return null
}

export function validateCanonicalProcedureBuilders(source, fileName = 'packages/api/src/trpc.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const declarations = new Map()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        declarations.set(declaration.name.text, builderSignature(declaration.initializer))
      }
    }
  }
  const violations = []
  for (const [name, expected] of CANONICAL_PROCEDURE_BUILDERS) {
    const actual = declarations.get(name)
    if (actual !== expected) {
      violations.push(`${fileName}: ${name} must be exactly ${expected}`)
    }
  }
  return violations
}

export function validateCanonicalAppRouterExports({ rootSource, indexSource }) {
  const root = ts.createSourceFile(
    'packages/api/src/root.ts',
    rootSource,
    ts.ScriptTarget.Latest,
    true,
  )
  const index = ts.createSourceFile(
    'packages/api/src/index.ts',
    indexSource,
    ts.ScriptTarget.Latest,
    true,
  )
  let rootExportsAppRouter = false
  let indexReexportsAppRouter = false

  for (const statement of root.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue
    rootExportsAppRouter ||= statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'appRouter',
    )
  }
  for (const statement of index.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== './root' ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue
    }
    indexReexportsAppRouter ||= statement.exportClause.elements.some(
      (element) =>
        (element.propertyName?.text ?? element.name.text) === 'appRouter' &&
        element.name.text === 'appRouter',
    )
  }

  const violations = []
  if (!rootExportsAppRouter) {
    violations.push('packages/api/src/root.ts: must export canonical appRouter')
  }
  if (!indexReexportsAppRouter) {
    violations.push('packages/api/src/index.ts: must re-export appRouter from ./root')
  }
  return violations
}

function resolveRelativeModule(fromFile, specifier, modules) {
  if (!specifier.startsWith('.')) return null
  const base = normalizePath(
    path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)),
  )
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (modules.has(candidate)) return candidate
  }
  return null
}

function procedureClass(node, fileName, modules, seen = new Set()) {
  const record = modules.get(fileName)
  if (!record) return null
  const current = unwrap(node)
  if (ts.isCallExpression(current)) {
    if (ts.isPropertyAccessExpression(current.expression)) {
      const result = procedureClass(current.expression.expression, fileName, modules, seen)
      if (
        (result === 'public' || result === 'public-ai') &&
        current.expression.name.text === 'use' &&
        current.arguments.length === 1 &&
        ts.isIdentifier(current.arguments[0]) &&
        current.arguments[0].text === 'requireGlobalAi'
      ) {
        return 'public-ai'
      }
      return result
    }
    return procedureClass(current.expression, fileName, modules, seen)
  }
  if (ts.isPropertyAccessExpression(current))
    return procedureClass(current.expression, fileName, modules, seen)
  if (!ts.isIdentifier(current)) return null
  if (fileName === 'packages/api/src/trpc.ts') {
    if (current.text === 'publicProcedure') return 'public'
    if (current.text === 'publicAiProcedure') return 'public-ai'
    if (
      current.text === 'protectedProcedure' ||
      current.text === 'tenantProcedure' ||
      current.text === 'adminProcedure' ||
      current.text === 'adminAiProcedure'
    ) {
      return 'authenticated'
    }
  }
  const identity = `${fileName}:${current.text}`
  if (seen.has(identity)) return null
  const nextSeen = new Set([...seen, identity])
  const initializer = record.variables.get(current.text)
  if (initializer) return procedureClass(initializer, fileName, modules, nextSeen)

  const imported = record.imports.get(current.text)
  if (!imported) return null
  const targetFile = resolveRelativeModule(fileName, imported.specifier, modules)
  if (!targetFile) return null
  return procedureClass(
    ts.factory.createIdentifier(imported.imported),
    targetFile,
    modules,
    nextSeen,
  )
}

function routerDefinition(record, routerName, fileName) {
  const initializer = record.variables.get(routerName)
  const current = initializer && unwrap(initializer)
  if (
    current &&
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === 'mergeRouters'
  ) {
    return { type: 'merge', components: current.arguments }
  }
  if (
    !current ||
    !ts.isCallExpression(current) ||
    !ts.isIdentifier(current.expression) ||
    current.expression.text !== 'router' ||
    !current.arguments[0] ||
    !ts.isObjectLiteralExpression(current.arguments[0])
  ) {
    throw new Error(`${fileName}: ${routerName} must be a static router object`)
  }
  return { type: 'object', object: current.arguments[0] }
}

export function discoverPublicTrpcSurfaces(moduleSources, rootFile, rootRouter = 'appRouter') {
  const modules = new Map(
    [...moduleSources.entries()].map(([fileName, source]) => [
      normalizePath(fileName),
      moduleRecord(source, normalizePath(fileName)),
    ]),
  )
  const violations = [...modules.values()].flatMap((record) => record.violations)
  const procedures = []
  const visiting = new Set()

  const visit = (fileName, routerName, prefix) => {
    const identity = `${fileName}:${routerName}`
    if (visiting.has(identity)) {
      violations.push(`${identity}: router composition cycle`)
      return
    }
    const record = modules.get(fileName)
    if (!record) {
      violations.push(`${fileName}: mounted router module is missing`)
      return
    }
    visiting.add(identity)
    let definition
    try {
      definition = routerDefinition(record, routerName, fileName)
    } catch (error) {
      violations.push(error instanceof Error ? error.message : `${identity}: invalid router`)
      visiting.delete(identity)
      return
    }

    const visitMounted = (mounted, canonicalPath) => {
      if (!ts.isIdentifier(mounted)) {
        violations.push(`${fileName}:${canonicalPath}: mounted routers must be identifiers`)
        return
      }
      const imported = record.imports.get(mounted.text)
      if (imported) {
        const targetFile = resolveRelativeModule(fileName, imported.specifier, modules)
        if (!targetFile) {
          violations.push(`${fileName}:${canonicalPath}: cannot resolve mounted router module`)
          return
        }
        visit(targetFile, imported.imported, canonicalPath)
      } else if (record.variables.has(mounted.text)) {
        visit(fileName, mounted.text, canonicalPath)
      } else {
        violations.push(`${fileName}:${canonicalPath}: cannot resolve mounted router`)
      }
    }

    if (definition.type === 'merge') {
      for (const component of definition.components) visitMounted(unwrap(component), prefix)
      visiting.delete(identity)
      return
    }

    for (const property of definition.object.properties) {
      if (!ts.isPropertyAssignment(property)) {
        violations.push(`${identity}: router entries must be static property assignments`)
        continue
      }
      const name = staticName(property.name)
      if (!name) {
        violations.push(`${identity}: router entry names must be static`)
        continue
      }
      const canonicalPath = prefix ? `${prefix}.${name}` : name
      const kind = terminalKind(property.initializer)
      if (kind) {
        const exposure = procedureClass(property.initializer, fileName, modules)
        if (exposure === 'public' || exposure === 'public-ai') {
          procedures.push({ path: canonicalPath, kind, exposure })
        } else if (exposure !== 'authenticated') {
          violations.push(`${fileName}:${canonicalPath}: cannot resolve procedure exposure`)
        }
        continue
      }

      visitMounted(unwrap(property.initializer), canonicalPath)
    }
    visiting.delete(identity)
  }

  visit(normalizePath(rootFile), rootRouter, '')
  return {
    procedures: procedures.sort((left, right) => left.path.localeCompare(right.path)),
    violations: [...new Set(violations)].sort(),
  }
}

export function discoverHttpMethods(source, fileName = 'route.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const methods = new Set()
  const violations = []

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name) {
      if (HTTP_METHODS.has(statement.name.text)) methods.add(statement.name.text)
      continue
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && HTTP_METHODS.has(declaration.name.text)) {
          methods.add(declaration.name.text)
        }
      }
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        violations.push(`${fileName}: HTTP route exports must be statically named`)
        continue
      }
      for (const element of statement.exportClause.elements) {
        if (HTTP_METHODS.has(element.name.text)) methods.add(element.name.text)
      }
    }
  }

  if (methods.size === 0) violations.push(`${fileName}: route module has no explicit HTTP method`)
  return { methods: [...methods].sort(), violations }
}

export function isNextRouteModuleName(name) {
  return /^route\.[cm]?[jt]sx?$/.test(name)
}

export function validateTrpcTransportBinding(source, fileName = 'route.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  let validFetchImport = false
  let validRouterImport = false
  const calls = []
  const variables = new Map()
  const exportedMethods = []
  const violations = []

  const bindingContains = (name, expected) => {
    if (ts.isIdentifier(name)) return name.text === expected
    return name.elements.some((element) => element.name && bindingContains(element.name, expected))
  }

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          variables.set(declaration.name.text, declaration.initializer)
          if (hasExportModifier(statement) && HTTP_METHODS.has(declaration.name.text)) {
            exportedMethods.push({ method: declaration.name.text, local: declaration.name.text })
          }
        }
      }
      continue
    }
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name) {
      if (HTTP_METHODS.has(statement.name.text)) {
        exportedMethods.push({ method: statement.name.text, local: statement.name.text })
      }
      continue
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (HTTP_METHODS.has(element.name.text)) {
            exportedMethods.push({
              method: element.name.text,
              local: element.propertyName?.text ?? element.name.text,
            })
          }
        }
      }
      continue
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text
      if (
        statement.moduleSpecifier.text === '@trpc/server/adapters/fetch' &&
        imported === 'fetchRequestHandler' &&
        element.name.text === 'fetchRequestHandler'
      ) {
        validFetchImport = true
      }
      if (
        statement.moduleSpecifier.text === '@pathfinder/api' &&
        imported === 'appRouter' &&
        element.name.text === 'appRouter'
      ) {
        validRouterImport = true
      }
    }
  }

  const visit = (node) => {
    if (
      ts.isParameter(node) &&
      (bindingContains(node.name, 'fetchRequestHandler') || bindingContains(node.name, 'appRouter'))
    ) {
      violations.push(`${fileName}: canonical transport bindings must not be shadowed`)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'fetchRequestHandler'
    ) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  if (!validFetchImport) violations.push(`${fileName}: must import canonical fetchRequestHandler`)
  if (!validRouterImport) violations.push(`${fileName}: must import canonical appRouter`)
  const canonicalCalls = new Set()
  for (const { method, local } of exportedMethods) {
    const initializer = variables.get(local)
    const handler = initializer && unwrap(initializer)
    const body =
      handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
        ? unwrap(handler.body)
        : null
    if (
      !body ||
      !ts.isCallExpression(body) ||
      !ts.isIdentifier(body.expression) ||
      body.expression.text !== 'fetchRequestHandler'
    ) {
      violations.push(`${fileName}: exported ${method} must invoke canonical fetchRequestHandler`)
      continue
    }
    canonicalCalls.add(body)
    const argument = unwrap(body.arguments[0])
    const optionNames = new Set()
    let invalidOptions = body.arguments.length !== 1 || !ts.isObjectLiteralExpression(argument)
    if (argument && ts.isObjectLiteralExpression(argument)) {
      for (const property of argument.properties) {
        const name =
          ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
            ? staticName(property.name)
            : null
        if (!name || optionNames.has(name)) invalidOptions = true
        else optionNames.add(name)
      }
    }
    if (invalidOptions) {
      violations.push(`${fileName}: exported ${method} must use static unique transport options`)
    }
    const routerProperties =
      argument && ts.isObjectLiteralExpression(argument)
        ? argument.properties.filter(
            (property) =>
              ts.isPropertyAssignment(property) && staticName(property.name) === 'router',
          )
        : []
    const routerProperty = routerProperties.length === 1 ? routerProperties[0] : undefined
    if (
      !routerProperty ||
      !ts.isPropertyAssignment(routerProperty) ||
      !ts.isIdentifier(unwrap(routerProperty.initializer)) ||
      unwrap(routerProperty.initializer).text !== 'appRouter'
    ) {
      violations.push(`${fileName}: exported ${method} router must be canonical appRouter`)
    }
  }
  if (exportedMethods.length === 0) {
    violations.push(`${fileName}: must export at least one canonical tRPC HTTP method`)
  }
  if (calls.length !== 1 || canonicalCalls.size !== 1 || !canonicalCalls.has(calls[0])) {
    violations.push(
      `${fileName}: exported HTTP methods must share exactly one canonical fetchRequestHandler call`,
    )
  }
  return violations
}

export function validateCanonicalApiPackageExports(packageManifest) {
  const violations = []
  if (
    !packageManifest ||
    typeof packageManifest !== 'object' ||
    Array.isArray(packageManifest) ||
    packageManifest.name !== '@pathfinder/api' ||
    packageManifest.exports?.['.'] !== './src/index.ts'
  ) {
    violations.push('packages/api/package.json: canonical package export must be ./src/index.ts')
  }
  return violations
}

export function discoverStringArray(source, variableName, fileName = 'source.ts') {
  const record = moduleRecord(source, fileName)
  const initializer = record.variables.get(variableName)
  if (!initializer || !ts.isArrayLiteralExpression(unwrap(initializer))) {
    return { values: [], violations: [`${fileName}: ${variableName} must be a static array`] }
  }
  const values = []
  const violations = []
  for (const element of unwrap(initializer).elements) {
    if (!ts.isStringLiteral(element)) {
      violations.push(`${fileName}: ${variableName} entries must be string literals`)
    } else values.push(element.text)
  }
  return { values, violations: [...record.violations, ...violations] }
}

function stable(value) {
  return JSON.stringify(value)
}

export function auditPublicSurfaceManifest({
  discoveredTrpc,
  discoveredHttp,
  publicApiPaths,
  manifest,
}) {
  const violations = []
  if (!manifest || manifest.version !== 1) violations.push('manifest version must be 1')
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    const topLevelKeys = new Set(['version', 'trpc', 'http', 'dashboardPublicApiPaths'])
    for (const key of Object.keys(manifest)) {
      if (!topLevelKeys.has(key)) violations.push(`manifest: unexpected key '${key}'`)
    }
  }
  const trpc = Array.isArray(manifest?.trpc) ? manifest.trpc : []
  const http = Array.isArray(manifest?.http) ? manifest.http : []
  if (!Array.isArray(manifest?.trpc)) violations.push('manifest trpc must be an array')
  if (!Array.isArray(manifest?.http)) violations.push('manifest http must be an array')

  const validateEntries = (entries, kind) => {
    const ids = new Set()
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        violations.push(`${kind}: entry must be an object`)
        continue
      }
      const allowedKeys = kind === 'trpc' ? TRPC_ENTRY_KEYS : HTTP_ENTRY_KEYS
      for (const key of Object.keys(entry)) {
        if (!allowedKeys.has(key)) violations.push(`${kind}: unexpected key '${key}'`)
      }
      const id = kind === 'trpc' ? entry?.path : entry?.source
      if (typeof id !== 'string' || id.length === 0) violations.push(`${kind}: invalid identity`)
      else if (ids.has(id)) violations.push(`${kind}: duplicate identity '${id}'`)
      else ids.add(id)
      if (!CONTROL_PROFILES.has(entry?.controlProfile)) {
        violations.push(`${kind}:${id ?? 'unknown'}: invalid control profile`)
      }
      if (kind === 'trpc') {
        const policy = TRPC_PROFILE_POLICY.get(entry.controlProfile)
        if (!policy || entry.exposure !== policy.exposure || entry.kind !== policy.kind) {
          violations.push(`${kind}:${id ?? 'unknown'}: control profile is incompatible`)
        }
      } else {
        const expectedExposure = HTTP_PROFILE_POLICY.get(entry.controlProfile)
        if (!expectedExposure || entry.exposure !== expectedExposure) {
          violations.push(`${kind}:${id ?? 'unknown'}: control profile is incompatible`)
        }
        if (
          !Array.isArray(entry.methods) ||
          entry.methods.length === 0 ||
          entry.methods.some((method) => !HTTP_METHODS.has(method)) ||
          new Set(entry.methods).size !== entry.methods.length ||
          stable([...entry.methods].sort()) !== stable(entry.methods)
        ) {
          violations.push(`${kind}:${id ?? 'unknown'}: invalid methods`)
        }
      }
      if (!Array.isArray(entry?.behavioralEvidence)) {
        violations.push(`${kind}:${id ?? 'unknown'}: behavioralEvidence must be an array`)
      } else {
        for (const evidencePath of entry.behavioralEvidence) {
          if (
            typeof evidencePath !== 'string' ||
            evidencePath.length === 0 ||
            path.posix.isAbsolute(evidencePath) ||
            normalizePath(evidencePath) !== evidencePath ||
            evidencePath.split('/').some((part) => part === '' || part === '.' || part === '..') ||
            !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(evidencePath)
          ) {
            violations.push(`${kind}:${id ?? 'unknown'}: invalid behavioral evidence path`)
          }
        }
        if (
          entry.behavioralEvidence.length === 0 &&
          (typeof entry.exceptionReason !== 'string' || entry.exceptionReason.trim().length === 0)
        ) {
          violations.push(`${kind}:${id ?? 'unknown'}: missing behavioral evidence or exception`)
        }
        if (entry.behavioralEvidence.length > 0 && entry.exceptionReason !== undefined) {
          violations.push(
            `${kind}:${id ?? 'unknown'}: evidence and exception are mutually exclusive`,
          )
        }
      }
    }
  }
  validateEntries(trpc, 'trpc')
  validateEntries(http, 'http')

  const actualTrpc = discoveredTrpc.map(({ path: procedurePath, kind, exposure }) => ({
    path: procedurePath,
    kind,
    exposure,
  }))
  const expectedTrpc = trpc.map(({ path: procedurePath, kind, exposure }) => ({
    path: procedurePath,
    kind,
    exposure,
  }))
  if (stable(actualTrpc) !== stable(expectedTrpc)) violations.push('tRPC public inventory drift')

  const actualHttp = discoveredHttp
    .map(({ source, methods }) => ({ source, methods }))
    .sort((a, b) => a.source.localeCompare(b.source))
  const expectedHttp = http
    .map(({ source, methods }) => ({ source, methods }))
    .sort((a, b) => a.source.localeCompare(b.source))
  if (stable(actualHttp) !== stable(expectedHttp)) violations.push('HTTP route inventory drift')

  const expectedPaths = Array.isArray(manifest?.dashboardPublicApiPaths)
    ? manifest.dashboardPublicApiPaths
    : []
  if (
    !Array.isArray(manifest?.dashboardPublicApiPaths) ||
    expectedPaths.some(
      (publicPath) =>
        typeof publicPath !== 'string' ||
        !publicPath.startsWith('/api/') ||
        publicPath.includes('?') ||
        publicPath.includes('#'),
    ) ||
    new Set(expectedPaths).size !== expectedPaths.length ||
    stable([...expectedPaths].sort()) !== stable(expectedPaths)
  ) {
    violations.push('manifest dashboard public API paths are invalid')
  }
  if (stable(publicApiPaths) !== stable(expectedPaths)) {
    violations.push('dashboard public API allowlist drift')
  }

  return violations
}

export function manifestEvidencePaths(manifest) {
  return [...(manifest.trpc ?? []), ...(manifest.http ?? [])].flatMap(
    (entry) => entry.behavioralEvidence ?? [],
  )
}
