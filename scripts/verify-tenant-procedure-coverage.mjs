import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiSourceDirectory = path.join(repositoryRoot, 'packages/api/src')
const casesPath = path.join(repositoryRoot, 'packages/api/src/testing/tenant-procedure-cases.json')
const roles = new Set(['STAFF', 'MANAGER', 'OWNER'])

async function collectRouterFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectRouterFiles(absolute)))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(absolute)
  }
  return files
}

function unwrapExpression(node) {
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

function chainRoot(node) {
  const current = unwrapExpression(node)
  if (ts.isIdentifier(current)) return current.text
  if (ts.isCallExpression(current)) return chainRoot(current.expression)
  if (ts.isPropertyAccessExpression(current)) return chainRoot(current.expression)
  return null
}

function terminalKind(node) {
  const current = unwrapExpression(node)
  if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) {
    return null
  }
  const name = current.expression.name.text
  return name === 'query' || name === 'mutation' ? name : null
}

function staticPropertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
  return null
}

function tenantProcedures(source, fileName = 'fixture.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const procedures = []
  const violations = []
  let tenantProcedureReferences = 0

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue
    const bindings = statement.importClause.namedBindings
    if (!ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if (
        element.propertyName?.text === 'tenantProcedure' &&
        element.name.text !== 'tenantProcedure'
      ) {
        violations.push(
          `${fileName}: tenantProcedure must not be imported through alias '${element.name.text}'`,
        )
      }
    }
  }

  const countReferences = (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === 'tenantProcedure' &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isExportSpecifier(node.parent)
    ) {
      tenantProcedureReferences += 1
    }
    ts.forEachChild(node, countReferences)
  }
  countReferences(sourceFile)

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith('Router')) continue
      const initializer = declaration.initializer && unwrapExpression(declaration.initializer)
      if (
        !initializer ||
        !ts.isCallExpression(initializer) ||
        !ts.isIdentifier(initializer.expression) ||
        initializer.expression.text !== 'router'
      ) {
        continue
      }
      const routes = initializer.arguments[0]
      if (!routes || !ts.isObjectLiteralExpression(routes)) {
        violations.push(`${fileName}: ${declaration.name.text} must use a static router object`)
        continue
      }
      const routerName = declaration.name.text.slice(0, -'Router'.length)
      for (const property of routes.properties) {
        if (!ts.isPropertyAssignment(property)) continue
        if (chainRoot(property.initializer) !== 'tenantProcedure') continue
        const procedureName = staticPropertyName(property.name)
        const kind = terminalKind(property.initializer)
        if (!procedureName || !kind) {
          violations.push(
            `${fileName}: tenant procedure must have a static name and query/mutation`,
          )
          continue
        }
        procedures.push({ path: `${routerName}.${procedureName}`, kind })
      }
    }
  }

  if (tenantProcedureReferences !== procedures.length) {
    violations.push(
      `${fileName}: found ${tenantProcedureReferences} tenantProcedure reference(s) but ${procedures.length} statically discoverable route(s)`,
    )
  }

  return { procedures, violations }
}

function containsTenantAuthority(value) {
  if (Array.isArray(value)) return value.some(containsTenantAuthority)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, item]) => /tenant|organizationid/i.test(key) || containsTenantAuthority(item),
  )
}

function auditCoverage(procedures, cases, parserViolations = []) {
  const violations = [...parserViolations]
  const actual = new Map()
  const covered = new Map()

  for (const procedure of procedures) {
    if (actual.has(procedure.path)) violations.push(`duplicate tenant procedure: ${procedure.path}`)
    actual.set(procedure.path, procedure)
  }
  for (const entry of cases) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
      violations.push('tenant procedure case must be an object with a path')
      continue
    }
    if (covered.has(entry.path)) violations.push(`duplicate tenant procedure case: ${entry.path}`)
    covered.set(entry.path, entry)
    if (entry.kind !== 'query' && entry.kind !== 'mutation') {
      violations.push(`${entry.path}: invalid procedure kind '${entry.kind}'`)
    }
    if (!roles.has(entry.minimumRole)) {
      violations.push(`${entry.path}: invalid minimumRole '${entry.minimumRole}'`)
    }
    if (typeof entry.firstTouch !== 'string' || !entry.firstTouch.includes('.')) {
      violations.push(`${entry.path}: firstTouch must be a dotted boundary path`)
    }
    if (containsTenantAuthority(entry.input)) {
      violations.push(`${entry.path}: adversarial input must not supply tenant authority`)
    }
  }

  for (const [procedurePath, procedure] of actual) {
    const entry = covered.get(procedurePath)
    if (!entry) violations.push(`${procedurePath}: missing generated cross-tenant case`)
    else if (entry.kind !== procedure.kind) {
      violations.push(
        `${procedurePath}: case kind '${entry.kind}' does not match router kind '${procedure.kind}'`,
      )
    }
  }
  for (const procedurePath of covered.keys()) {
    if (!actual.has(procedurePath)) violations.push(`${procedurePath}: stale cross-tenant case`)
  }

  return violations
}

function expectFailure(name, procedures, cases, fragment) {
  const violations = auditCoverage(procedures, cases)
  if (!violations.some((violation) => violation.includes(fragment))) {
    throw new Error(`Tenant procedure coverage verifier failed its ${name} self-test`)
  }
}

function runSelfTests() {
  const fixture = `
    const sampleRouter = router({
      read: tenantProcedure.query(async () => null),
      write: tenantProcedure.use(role).input(schema).mutation(async () => null),
      publicRead: publicProcedure.query(async () => null),
    })
  `
  const parsed = tenantProcedures(fixture)
  const cases = [
    {
      path: 'sample.read',
      kind: 'query',
      minimumRole: 'STAFF',
      firstTouch: 'thing.findMany',
      input: null,
    },
    {
      path: 'sample.write',
      kind: 'mutation',
      minimumRole: 'MANAGER',
      firstTouch: 'thing.create',
      input: { id: 'victim' },
    },
  ]
  if (parsed.procedures.length !== 2 || auditCoverage(parsed.procedures, cases).length > 0) {
    throw new Error('Tenant procedure coverage verifier failed its clean self-test')
  }
  expectFailure('missing case', parsed.procedures, cases.slice(0, 1), 'missing generated')
  expectFailure(
    'stale case',
    parsed.procedures,
    [...cases, { ...cases[0], path: 'sample.removed' }],
    'stale cross-tenant case',
  )
  expectFailure('duplicate case', parsed.procedures, [...cases, cases[0]], 'duplicate')
  expectFailure(
    'kind drift',
    parsed.procedures,
    [{ ...cases[0], kind: 'mutation' }, cases[1]],
    'does not match router kind',
  )
  expectFailure(
    'tenant authority',
    parsed.procedures,
    [{ ...cases[0], input: { tenantId: 'victim' } }, cases[1]],
    'must not supply tenant authority',
  )

  const aliased = tenantProcedures(`
    import { tenantProcedure as scoped } from './trpc'
    const sampleRouter = router({ read: scoped.query(async () => null) })
  `)
  if (!aliased.violations.some((violation) => violation.includes('imported through alias'))) {
    throw new Error('Tenant procedure coverage verifier failed its alias self-test')
  }

  for (const [name, fixtureSource] of [
    [
      'spread-hidden route',
      `
        const hidden = { read: tenantProcedure.query(async () => null) }
        const sampleRouter = router({ ...hidden })
      `,
    ],
    [
      'nonstandard router declaration',
      `const routes = router({ read: tenantProcedure.query(async () => null) })`,
    ],
  ]) {
    const result = tenantProcedures(fixtureSource)
    if (!result.violations.some((violation) => violation.includes('statically discoverable'))) {
      throw new Error(`Tenant procedure coverage verifier failed its ${name} self-test`)
    }
  }
}

runSelfTests()

const routerFiles = (await collectRouterFiles(apiSourceDirectory)).filter(
  (absolute) => path.basename(absolute) !== 'trpc.ts',
)
const parsed = await Promise.all(
  routerFiles.map(async (absolute) =>
    tenantProcedures(await readFile(absolute, 'utf8'), path.basename(absolute)),
  ),
)
const procedures = parsed.flatMap((result) => result.procedures)
const parserViolations = parsed.flatMap((result) => result.violations)
const cases = JSON.parse(await readFile(casesPath, 'utf8'))
if (!Array.isArray(cases)) throw new Error('Tenant procedure case catalog must be an array')

const violations = auditCoverage(procedures, cases, parserViolations)
if (violations.length > 0) {
  console.error('Tenant procedure cross-tenant coverage violations:')
  for (const violation of [...new Set(violations)].sort()) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(`Verified generated cross-tenant coverage for ${procedures.length} tenant procedures.`)
