import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ignoredDirectories = new Set(['.git', '.next', '.turbo', 'dist', 'node_modules'])
const sourceExtensions = new Set(['.ts', '.tsx'])
const bypassName = 'withTenantIsolationBypass'
const definitionPath = 'packages/db/src/middleware/tenant-isolation.ts'
const reexportPath = 'packages/db/src/index.ts'

// Exact counts make additions and removals review events without relying on line numbers.
const approvedCallCounts = new Map([
  ['apps/workers/src/index.ts', 1],
  ['apps/workers/src/processors/analytics-enrichment.ts', 1],
  ['apps/workers/src/processors/answer-analysis.ts', 2],
  ['apps/workers/src/processors/daily-rollup.ts', 3],
  ['apps/workers/src/processors/embed-knowledge-entry.ts', 1],
  ['apps/workers/src/processors/embed-place.ts', 1],
  ['apps/workers/src/processors/media-ingestion.ts', 9],
  ['apps/workers/src/processors/weekly-digest.ts', 2],
  ['apps/workers/src/processors/weekly-report.ts', 2],
  ['packages/api/src/routers/admin/_admin.ts', 28],
  ['packages/api/src/routers/admin/media-ingestion.ts', 12],
  ['packages/db/src/helpers/job-records.ts', 3],
])

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(absolute)))
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(absolute)
  }
  return files
}

function relativePath(absolute) {
  return path.relative(repositoryRoot, absolute).split(path.sep).join('/')
}

function isTestPath(fileName) {
  return /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(fileName)
}

function resolvesToDefinition(specifier, fileName) {
  if (!specifier.startsWith('.')) return false
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fileName), specifier))
  return resolved === definitionPath || `${resolved}.ts` === definitionPath
}

function isApprovedImportSource(specifier, fileName) {
  return specifier === '@pathfinder/db' || resolvesToDefinition(specifier, fileName)
}

function analyzeSource(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const violations = []
  let directImportCount = 0
  let callCount = 0
  let definitionCount = 0
  let reexportCount = 0

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const importSource = node.moduleSpecifier.text
      const namedBindings = node.importClause?.namedBindings
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text
          if (importedName !== bypassName) continue
          if (!isApprovedImportSource(importSource, fileName)) {
            violations.push(`${fileName}: ${bypassName} imported from unapproved '${importSource}'`)
          }
          if (element.name.text !== bypassName) {
            violations.push(`${fileName}: ${bypassName} import may not be aliased`)
          } else if (isApprovedImportSource(importSource, fileName)) {
            directImportCount += 1
          }
        }
      }
      if (
        namedBindings &&
        ts.isNamespaceImport(namedBindings) &&
        isApprovedImportSource(importSource, fileName)
      ) {
        violations.push(`${fileName}: namespace imports from '${importSource}' are not allowed`)
      }
    }

    if (ts.isFunctionDeclaration(node) && node.name?.text === bypassName) {
      definitionCount += 1
      const isExported = node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
      if (fileName !== definitionPath || !isExported) {
        violations.push(`${fileName}: ${bypassName} may be declared only as the exported boundary`)
      }
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        const importedName = element.propertyName?.text ?? element.name.text
        if (importedName !== bypassName) continue
        reexportCount += 1
        const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : ''
        if (
          fileName !== reexportPath ||
          element.name.text !== bypassName ||
          !resolvesToDefinition(specifier, fileName)
        ) {
          violations.push(
            `${fileName}: ${bypassName} must use the exact unaliased database re-export`,
          )
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const dynamicSpecifier = node.arguments[0]
      if (
        (isDynamicImport || isRequire) &&
        dynamicSpecifier &&
        (ts.isStringLiteral(dynamicSpecifier) ||
          ts.isNoSubstitutionTemplateLiteral(dynamicSpecifier)) &&
        isApprovedImportSource(dynamicSpecifier.text, fileName)
      ) {
        violations.push(`${fileName}: dynamic access to the tenant bypass module is not auditable`)
      }

      if (ts.isIdentifier(node.expression) && node.expression.text === bypassName) {
        callCount += 1
        if (
          node.arguments.length !== 1 ||
          (!ts.isArrowFunction(node.arguments[0]) && !ts.isFunctionExpression(node.arguments[0]))
        ) {
          violations.push(
            `${fileName}: ${bypassName} requires exactly one inline function argument`,
          )
        }
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === bypassName
      ) {
        violations.push(`${fileName}: member calls to ${bypassName} are not auditable`)
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === bypassName &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      violations.push(`${fileName}: member references to ${bypassName} are not auditable`)
    }
    if (
      ts.isElementAccessExpression(node) &&
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
      node.argumentExpression.text === bypassName
    ) {
      violations.push(`${fileName}: element access to ${bypassName} is not auditable`)
    }

    if (
      ts.isIdentifier(node) &&
      node.text === bypassName &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isExportSpecifier(node.parent) &&
      !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      violations.push(`${fileName}: indirect reference to ${bypassName} is not auditable`)
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  if (callCount > 0 && directImportCount !== 1) {
    violations.push(
      `${fileName}: ${callCount} bypass call(s) require exactly one approved direct import`,
    )
  }
  if (directImportCount > 0 && callCount === 0) {
    violations.push(`${fileName}: stale ${bypassName} import`)
  }

  return { callCount, definitionCount, reexportCount, violations }
}

function auditInventory(files, expectedCounts) {
  const violations = []
  const observedCounts = new Map()
  let definitionCount = 0
  let reexportCount = 0

  for (const { fileName, source } of files) {
    if (isTestPath(fileName)) continue
    const result = analyzeSource(source, fileName)
    violations.push(...result.violations)
    definitionCount += result.definitionCount
    reexportCount += result.reexportCount
    if (result.callCount > 0) observedCounts.set(fileName, result.callCount)
  }

  if (definitionCount !== 1) {
    violations.push(
      `expected exactly one exported ${bypassName} definition, observed ${definitionCount}`,
    )
  }
  if (reexportCount !== 1) {
    violations.push(
      `expected exactly one exact ${bypassName} database re-export, observed ${reexportCount}`,
    )
  }
  for (const [fileName, count] of observedCounts) {
    if (!expectedCounts.has(fileName)) {
      violations.push(`${fileName}: ${count} bypass call(s) in an unapproved production file`)
    }
  }
  for (const [fileName, expected] of expectedCounts) {
    const observed = observedCounts.get(fileName) ?? 0
    if (observed !== expected) {
      violations.push(`${fileName}: expected ${expected} bypass call(s), observed ${observed}`)
    }
  }

  return { observedCounts, violations }
}

function expectFixtureFailure(name, files, expectedCounts, messageFragment) {
  const result = auditInventory(files, expectedCounts)
  if (!result.violations.some((violation) => violation.includes(messageFragment))) {
    throw new Error(`Tenant bypass verifier failed its ${name} self-test`)
  }
}

function runSelfTests() {
  const approvedFile = 'apps/workers/src/approved.ts'
  const directImport = `import { ${bypassName} } from '@pathfinder/db'\n`
  const validCall = `${bypassName}(async () => undefined)\n`
  const expected = new Map([[approvedFile, 1]])
  const boundaries = [
    {
      fileName: definitionPath,
      source: `export async function ${bypassName}(fn) { return fn() }`,
    },
    {
      fileName: reexportPath,
      source: `export { ${bypassName} } from './middleware/tenant-isolation'`,
    },
  ]
  const fixture = (source) => [...boundaries, { fileName: approvedFile, source }]
  const clean = auditInventory(fixture(directImport + validCall), expected)
  if (clean.violations.length > 0 || clean.observedCounts.get(approvedFile) !== 1) {
    throw new Error('Tenant bypass verifier failed its clean fixture self-test')
  }

  expectFixtureFailure(
    'unapproved file',
    [
      ...fixture(directImport + validCall),
      { fileName: 'apps/web/src/escape.ts', source: directImport + validCall },
    ],
    expected,
    'unapproved production file',
  )
  expectFixtureFailure(
    'aliased import',
    fixture(
      `import { ${bypassName} as bypass } from '@pathfinder/db'\nbypass(async () => undefined)`,
    ),
    expected,
    'may not be aliased',
  )
  expectFixtureFailure(
    'foreign import',
    fixture(directImport.replace('@pathfinder/db', 'lib/db-shim') + validCall),
    expected,
    'imported from unapproved',
  )
  expectFixtureFailure(
    'spoofed relative origin',
    fixture(`import { ${bypassName} } from './fake/middleware/tenant-isolation'\n` + validCall),
    expected,
    'imported from unapproved',
  )
  expectFixtureFailure(
    'call shape',
    fixture(directImport + `${bypassName}(makeCallback())`),
    expected,
    'exactly one inline function argument',
  )
  expectFixtureFailure(
    'member call',
    fixture(`import * as db from '@pathfinder/db'\ndb.${bypassName}(async () => undefined)`),
    expected,
    'member calls',
  )
  expectFixtureFailure(
    'indirect reference',
    fixture(directImport + `const bypass = ${bypassName}\nbypass(async () => undefined)`),
    expected,
    'indirect reference',
  )
  expectFixtureFailure(
    'dynamic member extraction',
    fixture(
      directImport +
        validCall +
        `const hidden = (await import('@pathfinder/db')).${bypassName}\nhidden(async () => undefined)`,
    ),
    expected,
    'member references',
  )
  expectFixtureFailure(
    'dynamic destructuring',
    fixture(
      directImport +
        validCall +
        `const { '${bypassName}': hidden } = await import('@pathfinder/db')\n` +
        `hidden(async () => undefined)`,
    ),
    expected,
    'dynamic access to the tenant bypass module',
  )
  expectFixtureFailure(
    'element access',
    fixture(
      directImport +
        validCall +
        `(await import('@pathfinder/db'))['${bypassName}'](async () => undefined)`,
    ),
    expected,
    'element access',
  )
  expectFixtureFailure(
    'count drift',
    fixture(directImport + validCall + validCall),
    expected,
    'expected 1 bypass call(s), observed 2',
  )
  expectFixtureFailure(
    'stale allowlist',
    boundaries,
    expected,
    'expected 1 bypass call(s), observed 0',
  )
  expectFixtureFailure(
    'aliased re-export',
    [
      boundaries[0],
      {
        fileName: reexportPath,
        source: `export { ${bypassName} as hiddenBypass } from './middleware/tenant-isolation'`,
      },
      { fileName: approvedFile, source: directImport + validCall },
    ],
    expected,
    'exact unaliased database re-export',
  )
  expectFixtureFailure(
    'duplicate definition',
    [
      ...fixture(directImport + validCall),
      {
        fileName: 'packages/db/src/hidden.ts',
        source: `export async function ${bypassName}(fn) { return fn() }`,
      },
    ],
    expected,
    'may be declared only as the exported boundary',
  )
}

runSelfTests()

const sourceFiles = (
  await Promise.all(
    ['apps', 'packages'].map((directory) => collectFiles(path.join(repositoryRoot, directory))),
  )
).flat()
const files = await Promise.all(
  sourceFiles.map(async (absolute) => ({
    fileName: relativePath(absolute),
    source: await readFile(absolute, 'utf8'),
  })),
)
const result = auditInventory(files, approvedCallCounts)

if (result.violations.length > 0) {
  console.error('Tenant isolation bypass boundary violations:')
  for (const violation of [...new Set(result.violations)].sort()) console.error(`- ${violation}`)
  process.exit(1)
}

const total = [...result.observedCounts.values()].reduce((sum, count) => sum + count, 0)
console.log(
  `Verified ${total} tenant-isolation bypass calls across ${result.observedCounts.size} approved production files.`,
)
