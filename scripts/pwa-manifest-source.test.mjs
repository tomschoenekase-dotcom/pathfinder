import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestRoute = path.join(repositoryRoot, 'apps/web/app/manifest.ts')
const layout = path.join(repositoryRoot, 'apps/web/app/layout.tsx')
const publicManifest = path.join(repositoryRoot, 'apps/web/public/manifest.webmanifest')

test('the Metadata API route is the only web manifest source', async () => {
  await access(manifestRoute)

  const layoutSource = await readFile(layout, 'utf8')
  assert.doesNotMatch(layoutSource, /<link\s+[^>]*rel=["']manifest["']/iu)

  await assert.rejects(access(publicManifest), { code: 'ENOENT' })
})
