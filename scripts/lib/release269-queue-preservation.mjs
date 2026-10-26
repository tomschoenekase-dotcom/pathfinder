import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import {
  RELEASE269_QUEUE_BASE_NAMES,
  RELEASE269_QUEUE_COUNTS_LUA,
} from './release269-queue-readback.mjs'

export const QUEUE_PRESERVATION_SCHEMA = 'torchiko-release269-queue-preservation/v1'
export const QUEUE_PRESERVATION_APPROVAL = 'torchiko-preserve-dormant-queues-20261026'
const LIMIT = 2000
const MAX_KEYS = 10000
const MAX_BYTES = 16 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/u
const ALLOWED = Object.freeze({
  'gmail-sync': { 'gmail-sync-reconciliation': 'wait', 'gmail-sync-watch-renewal': 'wait' },
  'prospect-import': { 'prospect-import-commit': 'wait', 'prospect-import-inspect': 'wait' },
  'intake-upload-verification': { 'intake-upload-verification-process': 'wait' },
  'analytics-enrichment': { 'analytics-enrichment-scheduler': 'delayed' },
  'daily-rollup': { 'daily-rollup-scheduler': 'delayed' },
  'weekly-digest': { 'weekly-digest-scheduler': 'delayed' },
  'account-summary-refresh': { 'account-summary-refresh-scheduler': 'delayed' },
})

// No queue objects or write commands. Reaching the cap refuses, including exactly 2000 rows.
export const PRESERVED_JOBS_LUA = `local out = {}; local cap = tonumber(ARGV[1]); local total = 0
for i = 2, #ARGV do local name = ARGV[i]; local p = 'bull:' .. name .. ':'; local rows = {}
 local function add(state, ids) for _, id in ipairs(ids) do total = total + 1
  if total >= cap then return end
  local h = redis.call('HMGET', p .. id, 'name', 'attemptsMade', 'ats', 'processedOn')
  rows[#rows + 1] = {id=id, state=state, name=h[1] or cjson.null,
   attemptsMade=h[2] or '0', ats=h[3] or '0', processedOn=h[4] or cjson.null} end end
 for _, s in ipairs({'wait','paused','active'}) do add(s, redis.call('LRANGE',p..s,0,cap)) end
 for _, s in ipairs({'delayed','prioritized','waiting-children'}) do add(s, redis.call('ZRANGE',p..s,0,cap)) end
 out[name] = rows end
if total >= cap then return cjson.encode({overflow=true}) end
return cjson.encode(out)`

const hash = (value) => createHash('sha256').update(value).digest('hex')
function bounded(value) {
  assert.equal(typeof value, 'string', 'queue-response-not-text')
  assert.ok(Buffer.byteLength(value) <= MAX_BYTES, 'queue-response-too-large')
  return value
}
async function discover(connection) {
  let cursor = '0'
  const keys = new Set()
  let pages = 0
  do {
    const reply = await connection.call('SCAN', cursor, 'MATCH', 'bull:*', 'COUNT', '500')
    assert.ok(Array.isArray(reply) && reply.length === 2 && Array.isArray(reply[1]))
    cursor = String(reply[0])
    assert.match(cursor, /^\d+$/u)
    assert.ok(++pages < MAX_KEYS, 'queue-scan-overflow')
    for (const key of reply[1]) {
      assert.ok(typeof key === 'string' && /^bull:[a-z0-9-]+:.+$/u.test(key), 'queue-key-refused')
      keys.add(key)
      assert.ok(keys.size < MAX_KEYS, 'queue-key-cap')
    }
  } while (cursor !== '0')
  return [...keys].sort()
}

// Canonical content rather than DUMP: Redis incremental hash reordering is not a data change.
// TTL-bearing keys refuse this release-only dormant invariant; no expiration is concealed.
async function contentHash(connection, keys) {
  const digest = createHash('sha256')
  let bytes = 0
  for (const key of keys) {
    const type = await connection.call('TYPE', key)
    assert.equal(Number(await connection.call('PTTL', key)), -1, 'queue-expiring-or-missing-key')
    let data
    if (type === 'string') data = await connection.call('GET', key)
    else if (type === 'hash') {
      const flat = await connection.call('HGETALL', key)
      assert.ok(Array.isArray(flat) && flat.length % 2 === 0)
      data = []
      for (let i = 0; i < flat.length; i += 2) data.push([flat[i], flat[i + 1]])
      data.sort((a, b) => a[0].localeCompare(b[0], 'en'))
    } else if (type === 'list') data = await connection.call('LRANGE', key, '0', '-1')
    else if (type === 'set') data = (await connection.call('SMEMBERS', key)).sort()
    else if (type === 'zset') data = await connection.call('ZRANGE', key, '0', '-1', 'WITHSCORES')
    else if (type === 'stream') data = await connection.call('XRANGE', key, '-', '+')
    else throw new Error('queue-key-type-refused')
    const serialized = JSON.stringify([key, type, data])
    bytes += Buffer.byteLength(serialized)
    assert.ok(bytes <= MAX_BYTES, 'queue-content-cap')
    digest.update(serialized).update('\n')
  }
  assert.deepEqual(await discover(connection), keys, 'queue-keys-changed-during-read')
  return digest.digest('hex')
}

async function read(connection, target, now) {
  const keys = await discover(connection)
  const prefix = target === 'staging' ? 'staging--' : ''
  const registry = RELEASE269_QUEUE_BASE_NAMES.map((name) => prefix + name)
  const names = [...new Set([...registry, ...keys.map((key) => key.split(':')[1])])].sort()
  const countsRaw = bounded(
    await connection.call('EVAL_RO', RELEASE269_QUEUE_COUNTS_LUA, '0', ...names),
  )
  const counts = JSON.parse(countsRaw)
  const jobs = JSON.parse(
    bounded(await connection.call('EVAL_RO', PRESERVED_JOBS_LUA, '0', String(LIMIT), ...names)),
  )
  assert.deepEqual(Object.keys(counts).sort(), names, 'queue-count-coverage')
  assert.deepEqual(Object.keys(jobs).sort(), names, 'queue-job-coverage-or-cap')
  const clients = bounded(await connection.call('CLIENT', 'LIST'))
  assert.ok(clients.trim().length > 0, 'queue-client-list-empty')
  const clientNames = clients
    .trim()
    .split('\n')
    .map((line) => {
      assert.match(line, /(?:^| )id=\d+(?: |$)/u, 'queue-client-list-invalid')
      const match = /(?:^| )name=([^ ]*)(?: |$)/u.exec(line)
      assert.ok(match, 'queue-client-name-missing')
      return match[1]
    })
  const totals = {
    waiting: 0,
    active: 0,
    delayed: 0,
    prioritized: 0,
    waitingChildren: 0,
    failed: 0,
  }
  const normalized = {}
  let jobCount = 0
  for (const name of names) {
    const count = counts[name]
    assert.deepEqual(Object.keys(count).sort(), Object.keys(totals).sort(), 'queue-count-fields')
    for (const field of Object.keys(totals)) {
      assert.ok(Number.isSafeInteger(count[field]) && count[field] >= 0, 'queue-invalid-count')
      totals[field] += count[field]
    }
    for (const field of ['active', 'prioritized', 'waitingChildren'])
      assert.equal(count[field], 0, 'queue-unsafe-state')
    const worker = `bull:${Buffer.from(name).toString('base64')}`
    assert.ok(
      !clientNames.some((client) => client === worker || client.startsWith(`${worker}:w:`)),
      'queue-worker-connected',
    )
    const rows = Array.isArray(jobs[name]) ? jobs[name] : []
    assert.ok(
      Array.isArray(jobs[name]) || (jobs[name] && Object.keys(jobs[name]).length === 0),
      'queue-jobs-invalid',
    )
    assert.equal(rows.length, count.waiting + count.delayed, 'queue-count-job-mismatch')
    if (!registry.includes(name)) assert.equal(rows.length, 0, 'queue-unregistered-pending')
    const base = registry.includes(name) ? name.slice(prefix.length) : null
    for (const job of rows) {
      assert.ok(typeof job.id === 'string' && job.id.length > 0, 'queue-job-id')
      assert.equal(ALLOWED[base]?.[job.name], job.state, 'queue-job-not-allowlisted')
      assert.ok(['wait', 'delayed'].includes(job.state), 'queue-job-state')
      assert.equal(job.attemptsMade, '0', 'queue-job-attempted')
      assert.equal(job.ats, '0', 'queue-job-started')
      assert.equal(job.processedOn, null, 'queue-job-processed')
    }
    normalized[name] = rows.map((job) => JSON.stringify(job)).sort()
    assert.equal(new Set(rows.map((job) => job.id)).size, rows.length, 'queue-duplicate-job')
    jobCount += rows.length
  }
  assert.ok(jobCount < LIMIT, 'queue-job-cap')
  const canonicalSha256 = await contentHash(connection, keys)
  return {
    observedAt: now(),
    names,
    countsRaw,
    jobsSha256: hash(JSON.stringify(normalized)),
    canonicalSha256,
    totals,
  }
}

// Caller owns target identity verification and a single read-only connection.
// Transport failures intentionally lose all raw driver details (which may contain credentials).
export async function readPreservedQueues({
  connection,
  target,
  releaseSha,
  resourceIdentity,
  now = Date.now,
  sleep = setTimeout,
}) {
  assert.ok(['staging', 'production'].includes(target))
  assert.match(releaseSha ?? '', /^[a-f0-9]{40}$/u)
  assert.ok(typeof resourceIdentity === 'string' && resourceIdentity.length > 0)
  try {
    const before = await read(connection, target, now)
    await sleep(30000)
    const after = await read(connection, target, now)
    assert.ok(after.observedAt - before.observedAt >= 30000, 'queue-read-gap')
    assert.ok(after.observedAt - before.observedAt <= 120000, 'queue-read-timeout')
    assert.deepEqual(before.names, after.names, 'queue-registry-changed')
    assert.equal(before.countsRaw, after.countsRaw, 'queue-counts-changed')
    assert.equal(before.jobsSha256, after.jobsSha256, 'queue-jobs-changed')
    assert.equal(before.canonicalSha256, after.canonicalSha256, 'queue-content-changed')
    return {
      schema: QUEUE_PRESERVATION_SCHEMA,
      approval: QUEUE_PRESERVATION_APPROVAL,
      target,
      releaseSha,
      resourceIdentity,
      coverage: 'all-application-queues',
      firstObservedAt: new Date(before.observedAt).toISOString(),
      observedAt: new Date(after.observedAt).toISOString(),
      ...after.totals,
      registry: after.names,
      countsSha256: hash(after.countsRaw),
      jobsSha256: after.jobsSha256,
      canonicalSha256: after.canonicalSha256,
      workers: 0,
      transport: 'EVAL_RO-and-CLIENT-LIST',
      preserved: true,
    }
  } catch {
    throw new Error('release269-queue-preservation-refused')
  }
}

export function assertPreservedQueueProof(proof) {
  assert.equal(proof.schema, QUEUE_PRESERVATION_SCHEMA)
  assert.equal(proof.approval, QUEUE_PRESERVATION_APPROVAL)
  assert.equal(proof.transport, 'EVAL_RO-and-CLIENT-LIST')
  assert.equal(proof.preserved, true)
  assert.equal(proof.workers, 0)
  for (const field of ['active', 'prioritized', 'waitingChildren']) assert.equal(proof[field], 0)
  for (const field of ['waiting', 'delayed', 'failed'])
    assert.ok(Number.isSafeInteger(proof[field]) && proof[field] >= 0)
  assert.ok(proof.waiting + proof.delayed < LIMIT)
  for (const field of ['countsSha256', 'jobsSha256', 'canonicalSha256'])
    assert.match(proof[field] ?? '', HASH)
  const gap = Date.parse(proof.observedAt) - Date.parse(proof.firstObservedAt)
  assert.ok(gap >= 30000 && gap <= 120000)
  const prefix = proof.target === 'staging' ? 'staging--' : ''
  assert.ok(Array.isArray(proof.registry) && new Set(proof.registry).size === proof.registry.length)
  for (const name of RELEASE269_QUEUE_BASE_NAMES) assert.ok(proof.registry.includes(prefix + name))
}
