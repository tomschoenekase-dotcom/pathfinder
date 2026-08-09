import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoots = ['apps', 'packages']
const ignoredDirectories = new Set(['.next', '.turbo', 'dist', 'node_modules'])
const gatewayNames = new Set(['generateText', 'generateEmbedding', 'generateEmbeddings'])

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
  return null
}

function containsDefiniteBudgetGate(node) {
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'budgetGate') {
      return true
    }
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === 'budgetGate') {
      return !(
        property.initializer.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(property.initializer) && property.initializer.text === 'undefined')
      )
    }
  }
  return false
}

export function verifyAiBudgetSource(source, fileName = 'fixture.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const failures = []
  let callCount = 0
  const gatewayLocals = new Set(gatewayNames)
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue
    if (!ts.isNamedImports(statement.importClause.namedBindings)) continue
    for (const element of statement.importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      if (gatewayNames.has(importedName)) gatewayLocals.add(element.name.text)
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const gatewayName = ts.isIdentifier(node.expression)
        ? gatewayLocals.has(node.expression.text)
          ? node.expression.text
          : null
        : ts.isPropertyAccessExpression(node.expression) &&
            gatewayNames.has(node.expression.name.text)
          ? node.expression.name.text
          : null
      if (!gatewayName) {
        ts.forEachChild(node, visit)
        return
      }
      callCount += 1
      const options = node.arguments[0]
      if (
        !options ||
        !ts.isObjectLiteralExpression(options) ||
        !containsDefiniteBudgetGate(options)
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        failures.push(
          `${fileName}:${position.line + 1}:${position.character + 1} ${gatewayName} lacks definite budgetGate`,
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { callCount, failures }
}

async function sourceFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await sourceFiles(fullPath)))
    else if (
      entry.isFile() &&
      /\.tsx?$/u.test(entry.name) &&
      !/\.(?:test|spec)\.tsx?$/u.test(entry.name)
    ) {
      result.push(fullPath)
    }
  }
  return result
}

async function main() {
  const files = (
    await Promise.all(sourceRoots.map((root) => sourceFiles(path.join(repositoryRoot, root))))
  ).flat()
  const failures = []
  let callCount = 0
  for (const file of files) {
    const relative = path.relative(repositoryRoot, file).replaceAll('\\', '/')
    const result = verifyAiBudgetSource(await readFile(file, 'utf8'), relative)
    callCount += result.callCount
    failures.push(...result.failures)
  }
  if (failures.length > 0) {
    throw new Error(`AI budget boundary violations:\n${failures.join('\n')}`)
  }
  process.stdout.write(`Verified ${callCount} gateway call sites carry budget context.\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
