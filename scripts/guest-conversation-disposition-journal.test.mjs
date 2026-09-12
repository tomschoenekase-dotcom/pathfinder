import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, appendFile, readFile, stat, open, link, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initializeDispositionJournal,
  appendDispositionJournal,
  readDispositionJournal,
  dispositionSha256,
} from './lib/guest-conversation-disposition-journal.mjs'

const zero = '0'.repeat(64)
const intent = {
  version: 'guest-disposition-intent-v1',
  operationId: '9f530fa0-5853-4e9b-8dca-d454e93caa23',
  tenantId: 'synthetic-tenant',
  venueId: 'synthetic-venue',
  sessionId: 'synthetic-session',
  requestSha256: '1'.repeat(64),
  policyVersion: 'fixture-v1',
  policySha256: '2'.repeat(64),
  effectiveCutoffUtc: '2025-09-12T00:00:00.000Z',
  retiredTokenDigest: '3'.repeat(64),
  affected: {
    sessions: 1,
    messages: 2,
    turns: 1,
    engagementResponses: 1,
    feedback: 1,
    analyticsEvents: 1,
  },
  request: {
    version: 'guest-conversation-disposition-v1',
    operationId: '9f530fa0-5853-4e9b-8dca-d454e93caa23',
    tenantId: 'synthetic-tenant',
    venueId: 'synthetic-venue',
    sessionId: 'synthetic-session',
    expectedPolicyVersion: 'fixture-v1',
    expectedPolicySha256: '2'.repeat(64),
    basis: { kind: 'RETENTION_EXPIRY' },
  },
  authority: {
    version: 'guest-disposition-authority-v1',
    actorId: 'synthetic-operator',
    actorRole: 'PLATFORM_ADMIN',
    policyVersion: 'fixture-v1',
    policySha256: '2'.repeat(64),
    retentionDays: 365,
    holdAssessment: { status: 'NO_KNOWN_HOLD', referenceSha256: '4'.repeat(64) },
    basis: { kind: 'RETENTION_EXPIRY' },
  },
}
async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), 'pathfinder-synthetic-disposition-journal-'))
  const path = join(dir, 'journal.jsonl')
  await initializeDispositionJournal(path)
  return path
}

test('durable intent survives incomplete execution; exact replay does not append; completion binds same intent', async () => {
  const path = await fresh()
  const first = await appendDispositionJournal(path, zero, 'INTENT', intent)
  const pending = await readDispositionJournal(path, first.headSha256)
  assert.equal(pending.intents.size, 1)
  assert.equal(pending.completions.size, 0)
  const replay = await appendDispositionJournal(path, first.headSha256, 'INTENT', intent)
  assert.equal(replay.replayed, true)
  assert.equal(replay.headSha256, first.headSha256)
  const common = Object.fromEntries(
    Object.entries(intent).filter(
      ([key]) => !['request', 'authority', 'retiredTokenDigest'].includes(key),
    ),
  )
  const completion = {
    ...common,
    version: 'guest-disposition-db-receipt-v1',
    externalIntentSha256: dispositionSha256(intent),
  }
  const final = await appendDispositionJournal(path, replay.headSha256, 'COMPLETION', completion)
  assert.equal((await readDispositionJournal(path, final.headSha256)).completions.size, 1)
  await assert.rejects(readDispositionJournal(path, first.headSha256), /high-water mismatch/u)
})

test('partial write refuses without truncation or pretending the previous high-water is current', async () => {
  const path = await fresh()
  const first = await appendDispositionJournal(path, zero, 'INTENT', intent)
  await appendFile(path, '{"partial":')
  const bytes = await readFile(path)
  await assert.rejects(
    appendDispositionJournal(path, first.headSha256, 'INTENT', intent),
    /partial journal/u,
  )
  assert.deepEqual(await readFile(path), bytes)
  assert.equal((await stat(`${path}.writer-lock`)).isFile(), true)
  await assert.rejects(
    appendDispositionJournal(path, first.headSha256, 'INTENT', intent),
    /EEXIST/u,
  )
})

test('changed same-operation payload preserves journal and retains refusal lock', async () => {
  const path = await fresh()
  const first = await appendDispositionJournal(path, zero, 'INTENT', intent)
  const bytes = await readFile(path)
  await assert.rejects(
    appendDispositionJournal(path, first.headSha256, 'INTENT', {
      ...intent,
      requestSha256: '5'.repeat(64),
    }),
    /conflict/u,
  )
  assert.deepEqual(await readFile(path), bytes)
  assert.equal((await stat(`${path}.writer-lock`)).isFile(), true)
})

test('unknown content and orphan completion are rejected before journal append', async () => {
  const path = await fresh()
  await assert.rejects(
    appendDispositionJournal(path, zero, 'INTENT', {
      ...intent,
      guestText: 'synthetic forbidden text',
    }),
    /payload/u,
  )
  assert.equal((await readFile(path)).length, 0)
  const other = await fresh()
  const common = Object.fromEntries(
    Object.entries(intent).filter(
      ([key]) => !['request', 'authority', 'retiredTokenDigest'].includes(key),
    ),
  )
  await assert.rejects(
    appendDispositionJournal(other, zero, 'COMPLETION', {
      ...common,
      version: 'guest-disposition-db-receipt-v1',
      externalIntentSha256: dispositionSha256(intent),
    }),
    /completion does not match/u,
  )
  assert.equal((await readFile(other)).length, 0)
})

test('completion cannot change sealed cutoff/counts and an invalid kind cannot replay', async () => {
  for (const patch of [
    { effectiveCutoffUtc: '2025-09-13T00:00:00.000Z' },
    { affected: { ...intent.affected, messages: 1 } },
  ]) {
    const path = await fresh()
    const first = await appendDispositionJournal(path, zero, 'INTENT', intent)
    const common = Object.fromEntries(
      Object.entries(intent).filter(
        ([key]) => !['request', 'authority', 'retiredTokenDigest'].includes(key),
      ),
    )
    const completion = {
      ...common,
      version: 'guest-disposition-db-receipt-v1',
      externalIntentSha256: dispositionSha256(intent),
      ...patch,
    }
    const bytes = await readFile(path)
    await assert.rejects(
      appendDispositionJournal(path, first.headSha256, 'COMPLETION', completion),
      /completion does not match/u,
    )
    assert.deepEqual(await readFile(path), bytes)
  }
  const path = await fresh()
  const first = await appendDispositionJournal(path, zero, 'INTENT', intent)
  const common = Object.fromEntries(
    Object.entries(intent).filter(
      ([key]) => !['request', 'authority', 'retiredTokenDigest'].includes(key),
    ),
  )
  const completion = {
    ...common,
    version: 'guest-disposition-db-receipt-v1',
    externalIntentSha256: dispositionSha256(intent),
  }
  const final = await appendDispositionJournal(path, first.headSha256, 'COMPLETION', completion)
  await assert.rejects(
    appendDispositionJournal(path, final.headSha256, 'UNKNOWN', completion),
    /invalid kind/u,
  )
})

for (const failure of ['partial-append', 'fsync', 'readback']) {
  test(`actual file-handle ${failure} failure retains uncertainty lock and never retries`, async (t) => {
    const path = await fresh()
    const probe = await open(path, 'r')
    const prototype = Object.getPrototypeOf(probe)
    await probe.close()
    let calls = 0
    const method =
      failure === 'partial-append' ? 'writeFile' : failure === 'fsync' ? 'sync' : 'readFile'
    const original = prototype[method]
    const replacement = t.mock.method(prototype, method, async function (...args) {
      calls += 1
      // First operation is lock write/sync or journal's initial read; second
      // reaches the actual append, durability boundary or post-write readback.
      if (calls === 2) {
        if (failure === 'partial-append') await original.call(this, args[0].subarray(0, 31))
        if (failure === 'readback') return Buffer.from('deliberately mismatched readback\n')
        throw new Error(`injected-${failure}`)
      }
      return original.apply(this, args)
    })
    await assert.rejects(
      appendDispositionJournal(path, zero, 'INTENT', intent),
      /injected-|readback mismatch/u,
    )
    replacement.mock.restore()
    assert.equal(calls, 2)
    assert.equal((await stat(`${path}.writer-lock`)).isFile(), true)
    const bytes = await readFile(path)
    assert.ok(bytes.length > 0)
    if (failure === 'partial-append') assert.equal(bytes.length, 31)
    await assert.rejects(appendDispositionJournal(path, zero, 'INTENT', intent), /EEXIST/u)
    assert.deepEqual(await readFile(path), bytes)
  })
}

test('aliased file identity and journal-size cap refuse before reading or appending', async () => {
  const path = await fresh()
  await link(path, `${path}.alias`)
  await assert.rejects(readDispositionJournal(path, zero), /unsafe journal file/u)
  assert.equal((await readFile(path)).length, 0)
  const oversized = await fresh()
  await truncate(oversized, 32 * 1024 * 1024 + 1)
  await assert.rejects(readDispositionJournal(oversized, zero), /unsafe journal file/u)
  assert.equal((await stat(oversized)).size, 32 * 1024 * 1024 + 1)
})
