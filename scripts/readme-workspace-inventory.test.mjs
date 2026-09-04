import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  auditReadmeWorkspaceInventory,
  discoverWorkspaceManifestPaths,
  parsePnpmWorkspacePackagePatterns,
  parseReadmeWorkspaceInventory,
} from './lib/readme-workspace-inventory.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('README workspace parser is section-bounded and rejects malformed entries', () => {
  const markdown = [
    '# Example',
    '',
    '- `apps/outside`',
    '',
    '## Workspaces',
    '',
    '- `apps/web` — public app',
    '- `packages/api`',
    '',
    '## Other',
    '',
    '- `packages/outside`',
  ].join('\n')

  assert.deepEqual(parseReadmeWorkspaceInventory(markdown), ['apps/web', 'packages/api'])
  assert.deepEqual(
    parseReadmeWorkspaceInventory('## Workspaces\n\n- `.railway` — infrastructure\n'),
    ['.railway'],
  )
  assert.throws(
    () => parseReadmeWorkspaceInventory('## Workspaces\n\n- apps/web\n'),
    /Malformed README workspace entry/u,
  )
  assert.throws(
    () => parseReadmeWorkspaceInventory('## Workspaces\n\n  - `apps/web`\n'),
    /Malformed README workspace entry/u,
  )
  assert.throws(
    () => parseReadmeWorkspaceInventory('## Workspaces\n\n- `apps/web `\n'),
    /Malformed README workspace entry/u,
  )
})

test('workspace audit reports duplicates, missing manifests, and phantom documentation', () => {
  assert.deepEqual(
    auditReadmeWorkspaceInventory(
      ['apps/web', 'apps/web', 'apps/admin'],
      ['apps/web', 'packages/api'],
    ),
    {
      duplicates: ['apps/web'],
      missing: ['packages/api'],
      unexpected: ['apps/admin'],
      documented: ['apps/admin', 'apps/web'],
      manifests: ['apps/web', 'packages/api'],
    },
  )
})

test('pnpm workspace parser is section-bounded and rejects malformed patterns', () => {
  assert.deepEqual(
    parsePnpmWorkspacePackagePatterns(
      'packages:\n  - \'apps/*\' # apps\n  - "packages/*"\n  - tools/* # tools\n\ncatalog:\n',
    ),
    ['apps/*', 'packages/*', 'tools/*'],
  )
  assert.throws(
    () => parsePnpmWorkspacePackagePatterns('packages:\n  -\n'),
    /Malformed pnpm workspace package pattern/u,
  )
})

test('README lists every current workspace manifest exactly once and no removed workspace', async () => {
  const [markdown, workspaceYaml, packageJson] = await Promise.all([
    readFile(path.join(repositoryRoot, 'README.md'), 'utf8'),
    readFile(path.join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8').then(JSON.parse),
  ])
  const documentedPaths = parseReadmeWorkspaceInventory(markdown)
  const manifestPaths = await discoverWorkspaceManifestPaths(repositoryRoot)
  const workspacePatterns = parsePnpmWorkspacePackagePatterns(workspaceYaml)
  const result = auditReadmeWorkspaceInventory(documentedPaths, manifestPaths)

  assert.deepEqual(workspacePatterns, ['.railway', 'apps/*', 'packages/*'])
  assert.equal(packageJson.scripts['test:scripts'], 'node scripts/run-script-tests.mjs')
  assert.deepEqual(result.duplicates, [])
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.unexpected, [])
  assert.deepEqual(result.documented, result.manifests)
})
