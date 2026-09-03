import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import path from 'node:path'
import ts from 'typescript'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const roots = [
  path.join(repositoryRoot, 'apps', 'dashboard'),
  path.join(repositoryRoot, 'apps', 'web'),
]
const boundaryCalls = new Set(['runBoundedClientRequest', 'runProspectImportRequest'])

function productionFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (['.next', 'node_modules', 'test-results', 'tests'].includes(entry.name)) return []
      return productionFiles(file)
    }
    if (
      !entry.isFile() ||
      !/\.(?:ts|tsx)$/u.test(file) ||
      /\.(?:test|spec)\.(?:ts|tsx)$/u.test(file)
    )
      return []
    return [file]
  })
}

function isQueryCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'query'
  )
}

function isNativePermissionsQuery(call, source) {
  return call.expression.getText(source) === 'navigator.permissions.query'
}

function hasSignalOption(call) {
  const options = call.arguments[1]
  return Boolean(
    options &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return property.name.text === 'signal'
      return (
        ts.isPropertyAssignment(property) &&
        ((ts.isIdentifier(property.name) && property.name.text === 'signal') ||
          (ts.isStringLiteral(property.name) && property.name.text === 'signal'))
      )
    }),
  )
}

function boundaryAncestor(call) {
  let current = call.parent
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      boundaryCalls.has(current.expression.text)
    )
      return current.expression.text
    current = current.parent
  }
  return null
}

test('all production frontend tRPC queries use transport cancellation and an approved deadline', () => {
  const violations = []
  for (const file of roots.flatMap(productionFiles)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    function inspect(node) {
      if (isQueryCall(node) && !isNativePermissionsQuery(node, source)) {
        const location = source.getLineAndCharacterOfPosition(node.getStart(source))
        const label = `${path.relative(repositoryRoot, file)}:${location.line + 1}`
        if (!hasSignalOption(node)) violations.push(`${label} does not pass a signal option`)
        if (!boundaryAncestor(node))
          violations.push(`${label} is not enclosed by an approved deadline boundary`)
      }
      ts.forEachChild(node, inspect)
    }
    inspect(source)
  }
  assert.deepEqual(violations, [])
})
