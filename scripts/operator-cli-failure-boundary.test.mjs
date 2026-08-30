import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { reportOperatorCliFailure } from './lib/operator-cli-failure.mjs'

test('operator failure writer emits only validated codes', () => {
  const chunks = []
  const exitCode = reportOperatorCliFailure({
    action: 'release-verification.failed',
    errorCode: 'release-verification-failed',
    stderr: { write: (chunk) => chunks.push(chunk) },
  })
  assert.equal(exitCode, 1)
  assert.deepEqual(JSON.parse(chunks.join('')), {
    ok: false,
    action: 'release-verification.failed',
    errorCode: 'release-verification-failed',
  })
  assert.doesNotMatch(chunks.join(''), /password|secret|postgres/u)
})

test('operator failure writer rejects unsafe fields and exit semantics', () => {
  assert.throws(() =>
    reportOperatorCliFailure({ action: 'bad action', errorCode: 'safe-code' }),
  )
  assert.throws(() =>
    reportOperatorCliFailure({ action: 'safe.action', errorCode: 'unsafe secret' }),
  )
  assert.throws(() =>
    reportOperatorCliFailure({ action: 'safe.action', errorCode: 'safe-code', exitCode: 3 }),
  )
})

test('high-risk operator entrypoints use the code-only writer', async () => {
  const entrypoints = [
    'create-staging-handoff.mjs',
    'migrate-disposable-db.mjs',
    'run-media-admission-redis-gate.mjs',
    'run-queue-observability-redis-gate.mjs',
    'run-terminal-redrive-redis-gate.mjs',
    'torchiko.mjs',
    'verify-client-bundle-secrets.mjs',
    'verify-docker-context-boundary.mjs',
    'verify-release.mjs',
  ]
  for (const entrypoint of entrypoints) {
    const source = await readFile(new URL(entrypoint, import.meta.url), 'utf8')
    assert.match(source, /reportOperatorCliFailure/u, entrypoint)
    assert.doesNotMatch(source, /error\.message|console\.error/u, entrypoint)
    if (entrypoint === 'verify-client-bundle-secrets.mjs') {
      assert.doesNotMatch(source, /result\.(?:stdout|stderr)/u, entrypoint)
    }
  }
})
