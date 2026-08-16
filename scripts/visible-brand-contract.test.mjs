import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const roots = ['apps/dashboard', 'apps/web', 'packages/ui', 'packages/contracts']

const explicitFiles = [
  'packages/api/src/lib/generation-request-identity.ts',
  'packages/api/src/mcp/registry.ts',
]

const technicalAllowlist = new Map([
  [
    'packages/api/src/lib/generation-request-identity.ts',
    new Set(["export const LEGACY_DEFAULT_WEEKLY_REPORT_TITLE = 'PathFinder Weekly Report'"]),
  ],
  [
    'apps/dashboard/lib/media-source-identity.test.ts',
    new Set(["const source = new Blob([new TextEncoder().encode('PathFinder source archive')])"]),
  ],
  [
    'apps/dashboard/lib/media-source-identity.ts',
    new Set([
      "const DOMAIN = new TextEncoder().encode('PathFinder media source fingerprint v1\\0')",
    ]),
  ],
  ['apps/web/middleware.ts', new Set(["'X-PathFinder-Revision':"])],
  [
    'apps/web/middleware.test.ts',
    new Set([
      "expect(headers?.get('X-PathFinder-Revision')).toBe(revision)",
      "expect(response?.headers.get('X-PathFinder-Revision')).toBe(",
      "expect(response?.headers.has('X-PathFinder-Revision')).toBe(false)",
    ]),
  ],
  [
    'apps/web/app/api/widget-ready/[venueSlug]/route.ts',
    new Set([
      "'Access-Control-Expose-Headers': 'X-PathFinder-Revision, X-PathFinder-Widget-Ready',",
      "'X-PathFinder-Revision':",
      "'X-PathFinder-Widget-Ready': '1',",
    ]),
  ],
  [
    'apps/web/app/api/widget-ready/[venueSlug]/route.test.ts',
    new Set(["'X-PathFinder-Revision, X-PathFinder-Widget-Ready',"]),
  ],
  [
    'apps/web/lib/widget-loader.test.ts',
    new Set(["headers: { 'X-PathFinder-Widget-Ready': '1' },"]),
  ],
  [
    'apps/web/public/widget.js',
    new Set(["response.headers.get('X-PathFinder-Widget-Ready') !== '1'"]),
  ],
])

async function sourceFiles(relativeRoot) {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot)
  const entries = await readdir(absoluteRoot, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeRoot, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(relativePath)))
    } else if (/\.(?:html|js|ts|tsx)$/u.test(entry.name)) {
      files.push(relativePath)
    }
  }
  return files
}

test('visible product copy uses Torchico while legacy technical contracts remain explicit', async () => {
  const files = [...(await Promise.all(roots.map(sourceFiles))).flat(), ...explicitFiles]
  const violations = []

  for (const relativePath of files) {
    const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8')
    const allowed = technicalAllowlist.get(relativePath) ?? new Set()
    source.split(/\r?\n/u).forEach((line, index) => {
      if (!line.includes('PathFinder')) return
      const trimmed = line.trim()
      if (allowed.has(trimmed)) return
      violations.push(`${relativePath}:${index + 1}: ${trimmed}`)
    })
  }

  assert.deepEqual(
    violations,
    [],
    `Old visible brand copy remains outside the technical allowlist:\n${violations.join('\n')}`,
  )
})
