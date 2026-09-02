import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ADMIN_COMPONENTS = join(process.cwd(), 'components', 'admin')
const BOUNDARY_CALLS = new Set(['runBoundedClientRequest', 'runProspectImportRequest'])

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return componentFiles(path)
    return entry.isFile() && path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : []
  })
}

function isQueryCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'query'
  )
}

function hasSignalOption(call: ts.CallExpression): boolean {
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

function boundaryAncestor(call: ts.CallExpression): string | null {
  let current: ts.Node | undefined = call.parent
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      BOUNDARY_CALLS.has(current.expression.text)
    ) {
      return current.expression.text
    }
    current = current.parent
  }
  return null
}

describe('admin component query boundaries', () => {
  it('keeps every direct tRPC query inside an approved deadline boundary with a signal', () => {
    const violations: string[] = []

    for (const file of componentFiles(ADMIN_COMPONENTS)) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      )
      const inspect = (node: ts.Node) => {
        if (isQueryCall(node)) {
          const location = source.getLineAndCharacterOfPosition(node.getStart(source))
          const label = `${relative(process.cwd(), file)}:${location.line + 1}`
          if (!hasSignalOption(node)) violations.push(`${label} does not pass a signal option`)
          if (!boundaryAncestor(node)) {
            violations.push(`${label} is not enclosed by an approved deadline boundary`)
          }
        }
        ts.forEachChild(node, inspect)
      }
      inspect(source)
    }

    expect(violations).toEqual([])
  })
})
