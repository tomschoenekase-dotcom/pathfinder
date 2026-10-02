import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression for the /admin/operator outage (and the same defect on /look-and-feel): a server component imported the value OPERATOR_TABS
 * from a 'use client' module and called `.find` on it. Under the React server runtime that import
 * is an opaque client reference, so every render threw (jsdom unit tests cannot see this).
 * Server components may import only components (and types) from client modules.
 */
const here = dirname(fileURLToPath(import.meta.url))
const dashboardRoot = resolve(here, '..')
const SOURCE_DIRS = ['app', 'components', 'lib']

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : []
  })
}

// Every module without 'use client' may be rendered as a server module (pages, layouts, and the
// plain helpers they import), so each is held to the rule.
const serverFiles = SOURCE_DIRS.flatMap((dir) => walk(join(dashboardRoot, dir))).filter(
  (file) => !/^\s*['"]use client['"]/.test(readFileSync(file, 'utf8')),
)

function resolveModule(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier)
  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const isComponentName = (name: string) => /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name)

describe('server components importing from client modules', () => {
  it('finds the dashboard server modules', () => {
    expect(serverFiles.length).toBeGreaterThan(50)
  })

  for (const file of serverFiles) {
    it(`${file.slice(dashboardRoot.length + 1)} imports only components from client modules`, () => {
      const source = readFileSync(file, 'utf8')
      const imports = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.[^']+)'/g)]
      for (const [statement, names, specifier] of imports) {
        if (statement.startsWith('import type')) continue
        const target = resolveModule(file, specifier!)
        if (!target || !/^\s*['"]use client['"]/.test(readFileSync(target, 'utf8'))) continue
        const values = names!
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part && !part.startsWith('type '))
          .map((part) => part.split(/\s+as\s+/)[0]!.trim())
        for (const value of values) {
          expect(
            isComponentName(value),
            `${value} is a value imported from a 'use client' module (${specifier})`,
          ).toBe(true)
        }
      }
    })
  }
})
