import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const roots = ['apps/dashboard', 'apps/web', 'apps/workers', 'packages/ui', 'packages/contracts']

const explicitFiles = [
  'packages/api/src/lib/generation-request-identity.ts',
  'packages/api/src/mcp/registry.ts',
  'packages/db/prisma/schema.prisma',
]

const technicalAllowlist = new Map([
  [
    'apps/dashboard/components/admin/ApprovalDecisionForm.tsx',
    new Set([
      "proposedAction === 'pathfinder.apply_support_information_request'",
      "const isSupportCompletion = proposedAction === 'pathfinder.apply_support_completion'",
      "const isSupportPackageDraft = proposedAction === 'pathfinder.apply_support_package_draft'",
      ": proposedAction === 'pathfinder.apply_support_triage'",
      ": proposedAction === 'pathfinder.apply_support_triage' && decision === 'APPROVED'",
    ]),
  ],
  [
    'packages/contracts/src/agent-approval-policy.ts',
    new Set([
      "export const SUPPORT_TRIAGE_APPLY_ACTION = 'pathfinder.apply_support_triage' as const",
      "'pathfinder.apply_support_information_request' as const",
      "export const SUPPORT_COMPLETION_APPLY_ACTION = 'pathfinder.apply_support_completion' as const",
      "export const SUPPORT_PACKAGE_DRAFT_APPLY_ACTION = 'pathfinder.apply_support_package_draft' as const",
    ]),
  ],
  [
    'packages/contracts/src/mcp-v0.ts',
    new Set([
      "| 'pathfinder.apply_support_triage'",
      "| 'pathfinder.apply_support_information_request'",
      "name: 'pathfinder.apply_support_triage',",
      "name: 'pathfinder.apply_support_information_request',",
      "| 'pathfinder.apply_support_completion'",
      "name: 'pathfinder.apply_support_completion',",
      "| 'pathfinder.apply_support_package_draft'",
      "name: 'pathfinder.apply_support_package_draft',",
    ]),
  ],
  [
    'packages/api/src/mcp/registry.ts',
    new Set([
      "case 'pathfinder.apply_support_triage': {",
      "'pathfinder.apply_support_triage',",
      "case 'pathfinder.apply_support_information_request': {",
      "'pathfinder.apply_support_information_request',",
      "case 'pathfinder.apply_support_completion': {",
      "'pathfinder.apply_support_completion',",
      "case 'pathfinder.apply_support_package_draft': {",
      "'pathfinder.apply_support_package_draft',",
    ]),
  ],
  [
    'packages/ui/src/brand.test.ts',
    new Set([
      "['PathFinder Staging QA', 'Torchiko Staging QA'],",
      "['Torchico Weekly Report', 'Torchiko Weekly Report'],",
    ]),
  ],
  [
    'packages/api/src/lib/generation-request-identity.ts',
    new Set(["'Torchico Weekly Report',", "'PathFinder Weekly Report',"]),
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
  [
    'apps/web/middleware.ts',
    new Set([
      "'X-PathFinder-Revision':",
      "'X-PathFinder-Revision': resolveReleaseRevision(environment),",
    ]),
  ],
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
      "'X-PathFinder-Revision': resolveReleaseRevision(process.env),",
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
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist')
      continue
    const relativePath = path.posix.join(relativeRoot, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(relativePath)))
    } else if (
      /\.(?:html|js|ts|tsx)$/u.test(entry.name) &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('.spec.')
    ) {
      files.push(relativePath)
    }
  }
  return files
}

test('visible product copy uses Torchiko while legacy technical contracts remain explicit', async () => {
  const files = [...(await Promise.all(roots.map(sourceFiles))).flat(), ...explicitFiles]
  const violations = []

  for (const relativePath of files) {
    const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8')
    const allowed = technicalAllowlist.get(relativePath) ?? new Set()
    source.split(/\r?\n/u).forEach((line, index) => {
      const renderedSource =
        /\.(?:html|tsx)$/u.test(relativePath) && !relativePath.includes('.test.')
      if (
        !line.includes('PathFinder') &&
        !line.includes('Torchico') &&
        !line.includes('pathfinder.app') &&
        !(renderedSource && line.includes('PATHFINDER'))
      )
        return
      const trimmed = line.trim()
      if (allowed.has(trimmed)) return
      violations.push(`${relativePath}:${index + 1}: ${trimmed}`)
    })
  }

  assert.deepEqual(
    violations,
    [],
    `Old visible brand or domain remains outside the technical allowlist:\n${violations.join('\n')}`,
  )
})
