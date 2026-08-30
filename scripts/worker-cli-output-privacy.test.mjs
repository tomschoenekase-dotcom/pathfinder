import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const guardedEntrypoints = [
  'apps/workers/src/scripts/embedding-freshness.ts',
  'apps/workers/src/scripts/embedding-claim-repair.ts',
  'apps/workers/src/scripts/terminal-redrive.ts',
]

test('operator worker CLIs cannot serialize arbitrary exception text', async () => {
  for (const relativePath of guardedEntrypoints) {
    const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8')
    assert.match(source, /writeSafeCliFailure/u, `${relativePath} must use the safe failure writer`)
    assert.doesNotMatch(source, /error\s*:\s*.*\.message/u, `${relativePath} exposes error.message`)
    assert.doesNotMatch(source, /String\(error\)/u, `${relativePath} stringifies an arbitrary error`)
  }
})

test('the safe worker CLI writer has no exception-text field and validates string metadata', async () => {
  const source = await readFile(
    path.join(repositoryRoot, 'apps/workers/src/lib/safe-cli-failure.ts'),
    'utf8',
  )
  assert.doesNotMatch(source, /\berror\??\s*:/u)
  assert.match(source, /SAFE_ACTION\.test\(failure\.action\)/u)
  assert.match(source, /SAFE_ERROR_CODE\.test\(failure\.errorCode\)/u)
  assert.match(source, /SAFE_ENVIRONMENTS\.has\(failure\.environment\)/u)
})
