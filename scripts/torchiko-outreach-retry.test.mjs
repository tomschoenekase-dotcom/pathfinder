import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createOutreachRetryArtifacts } from './lib/torchiko-outreach-retry.mjs'
const result = () => ({ schema: 'torchiko.native-writer-result/1', taskId: `writer-task_${'a'.repeat(64)}`,
  binding: { venueId: 'SYN-ONLY', recipient: 'fixture@example.invalid' }, generatedBy: { kind: 'model', identity: 'synthetic-unit-test' },
  subject: 'Synthetic 🌳 subject', body: 'Hello there,\n\nUnchanged synthetic body.\n', annotations: [], languageUses: [], assessment: null })
test('create-only exact request bodies survive a new instance without becoming CRM state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'torchiko-private-retry-test-'))
  try {
    const input = result(), store = createOutreachRetryArtifacts(root), original = structuredClone(input)
    const first = await store.retain(input), again = await store.retain(input)
    assert.deepEqual(input, original); assert.equal(again.sha256, first.sha256)
    const fresh = createOutreachRetryArtifacts(root), found = await fresh.locate(input.taskId)
    assert.equal(found.artifacts.length, 1); assert.equal(found.state, 'ONE_EXACT_RETAINED_RESULT')
    assert.deepEqual(await fresh.read(input.taskId, first.sha256), input)
    assert.equal((await readFile(first.file, 'utf8')), JSON.stringify(input, null, 2) + '\n')
    assert.equal(first.SEND_AUTHORIZED, false); assert.equal(first.kind, 'EXACT_NATIVE_REQUEST_BODY_ONLY')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('corruption, traversal, oversized and non-model artifacts fail closed without overwrite', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'torchiko-private-retry-test-'))
  try {
    const store = createOutreachRetryArtifacts(root), input = result(), first = await store.retain(input)
    await writeFile(first.file, 'preserve this corrupted synthetic fixture')
    await assert.rejects(store.read(input.taskId, first.sha256), /bytes changed/)
    await assert.rejects(store.retain(input), /bytes changed/)
    assert.equal(await readFile(first.file, 'utf8'), 'preserve this corrupted synthetic fixture')
    await assert.rejects(store.locate('../another-workspace'), /exact native writer task/)
    await assert.rejects(store.read(input.taskId, '../outside'), /SHA-256/)
    await assert.rejects(store.retain({ ...input, generatedBy: { kind: 'human' } }), /model-authored/)
    await assert.rejects(store.retain({ ...input, body: 'x'.repeat(60001) }), /bounded/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('changed text produces separately retained versions requiring exact selection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'torchiko-private-retry-test-'))
  try {
    const store = createOutreachRetryArtifacts(root), input = result(), first = await store.retain(input)
    const second = await store.retain({ ...input, body: input.body + 'Different original ending.' })
    assert.notEqual(first.sha256, second.sha256)
    assert.equal((await store.locate(input.taskId)).state, 'SELECT_EXACT_RETAINED_RESULT')
    assert.deepEqual(await store.read(input.taskId, first.sha256), input)
  } finally { await rm(root, { recursive: true, force: true }) }
})
