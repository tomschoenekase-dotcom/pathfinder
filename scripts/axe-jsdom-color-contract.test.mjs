import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dashboard = path.join(root, 'apps', 'dashboard')

async function testFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) return testFiles(absolute)
      return entry.isFile() && entry.name.endsWith('.test.tsx') ? [absolute] : []
    }),
  )
  return nested.flat()
}

test('jsdom axe calls disable the layout-dependent color contrast rule', async () => {
  const files = await testFiles(dashboard)
  const violations = []
  let callCount = 0

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/axe\.run\(([\s\S]*?)\)/gu)) {
      callCount += 1
      const invocation = match[1]
      if (
        !invocation.includes("'color-contrast': { enabled: false }") &&
        !invocation.includes('axeOptions')
      ) {
        violations.push(path.relative(root, file))
      }
    }
  }

  assert.ok(callCount >= 50, `Expected at least 50 dashboard axe calls, found ${callCount}`)
  assert.deepEqual([...new Set(violations)].sort(), [])
})
