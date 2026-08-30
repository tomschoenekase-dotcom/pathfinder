import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  disposableRunnerFailureRecord,
  reportDisposableRunnerFailure,
} from './lib/disposable-runner-failure.mjs'

class ExampleRefusal extends Error {}

test('disposable runner failures emit only entrypoint-derived codes', () => {
  const secret = 'postgres://operator:secret@example.test/torchiko'
  const entrypoint = new URL('./run-disposable-golden-venue.mjs', import.meta.url)
  const record = disposableRunnerFailureRecord(new Error(secret), entrypoint)
  assert.deepEqual(record, {
    ok: false,
    action: 'disposable.golden-venue.failed',
    errorCode: 'disposable-runner-failed',
  })
  assert.doesNotMatch(JSON.stringify(record), /operator|secret|postgres/u)
})

test('refusal and cleanup outcomes keep distinct exit semantics without cause text', () => {
  const chunks = []
  const entrypoint = new URL('./run-disposable-agent-bridge.mjs', import.meta.url)
  assert.equal(
    reportDisposableRunnerFailure(new ExampleRefusal('private'), entrypoint, {
      write: (chunk) => chunks.push(chunk),
    }),
    2,
  )
  assert.equal(
    reportDisposableRunnerFailure(
      new AggregateError([new Error('credential private')], 'cleanup private'),
      entrypoint,
      { write: (chunk) => chunks.push(chunk) },
    ),
    1,
  )
  assert.doesNotMatch(chunks.join(''), /credential|private/u)
  assert.match(chunks[0], /disposable-runner-refused/u)
  assert.match(chunks[1], /disposable-runner-cleanup-failed/u)
})

test('every disposable shakedown entrypoint uses the code-only reporter', async () => {
  const directory = new URL('./', import.meta.url)
  const entrypoints = (await readdir(directory))
    .filter((name) => /^run-disposable-.*\.mjs$/u.test(name))
    .sort()
  assert.equal(entrypoints.length, 28)

  for (const entrypoint of entrypoints) {
    const source = await readFile(new URL(entrypoint, directory), 'utf8')
    assert.match(source, /reportDisposableRunnerFailure\(error, import\.meta\.url\)/u)
    assert.doesNotMatch(source, /error\.message|cause instanceof Error|console\.error/u)
  }
})
