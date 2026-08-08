import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const removedEnvironmentKey = ['POSTHOG', 'API', 'KEY'].join('_')

test('live configuration does not advertise an unimplemented product-analytics vendor', async () => {
  const liveConfigurationPaths = [
    '.env.example',
    '.github/workflows/ci.yml',
    'packages/config/src/env.ts',
    'scripts/lib/client-bundle-secret-scan.mjs',
  ]

  for (const relativePath of liveConfigurationPaths) {
    const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8')
    assert.equal(
      source.includes(removedEnvironmentKey),
      false,
      `${relativePath} must not retain the removed vendor key`,
    )
  }

  for (const relativePath of ['package.json', 'pnpm-lock.yaml']) {
    const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8')
    assert.doesNotMatch(source, /["/]posthog-(?:js|node)["@:\s]/iu)
  }
})
