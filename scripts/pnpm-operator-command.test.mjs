import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const invalidSeparator = /\bpnpm(?:\.cmd)?\s+(?:run\s+)?[\w:-]+\s+--\s+--[\w-]+/g

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path)
  }
  return files
}

test('operator-facing pnpm script commands do not forward a literal option separator', async () => {
  const files = [
    ...(await markdownFiles(join(root, 'docs'))),
    join(root, 'README.md'),
    join(root, 'scripts', 'local-staging.ps1'),
    join(root, 'scripts', 'lib', 'staging-handoff-manifest.mjs'),
  ]
  const offenders = []

  for (const path of files) {
    const source = await readFile(path, 'utf8')
    if (invalidSeparator.test(source)) offenders.push(relative(root, path).replaceAll('\\', '/'))
    invalidSeparator.lastIndex = 0
  }

  assert.deepEqual(offenders, [])
})
