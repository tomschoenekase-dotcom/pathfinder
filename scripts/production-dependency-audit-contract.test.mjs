import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('production dependency audit remains an enforced CI gate', async () => {
  const rootPackage = await readJson('package.json')
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8')

  assert.equal(rootPackage.scripts['audit:prod'], 'pnpm audit --prod --audit-level high')
  assert.match(workflow, /^\s+run: pnpm audit:prod$/mu)
})

test('known production advisory fixes remain pinned to reviewed patched versions', async () => {
  const rootPackage = await readJson('package.json')
  const apiPackage = await readJson('packages/api/package.json')

  assert.equal(rootPackage.pnpm.overrides['postcss>nanoid'], '3.3.18')
  assert.equal(rootPackage.pnpm.overrides['@prisma/config>deepmerge-ts'], '8.0.0')
  assert.equal(apiPackage.dependencies['pdfjs-dist'], '6.2.108')
})
