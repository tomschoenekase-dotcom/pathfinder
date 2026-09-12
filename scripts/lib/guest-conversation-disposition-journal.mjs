import { createHash } from 'node:crypto'
import { open, lstat, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  GuestConversationDispositionRequest,
  GuestConversationDispositionAuthoritySnapshot,
} from '../../packages/contracts/src/guest-conversation-disposition.runtime.mjs'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const ZERO = '0'.repeat(64)
const digestPattern = /^[a-f0-9]{64}$/u
const operationPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u

export function canonicalDispositionJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalDispositionJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalDispositionJson(value[key])}`)
    .join(',')}}`
}

export function dispositionSha256(value) {
  return createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalDispositionJson(value),
    )
    .digest('hex')
}

function refuse(message) {
  throw new Error(`GUEST_DISPOSITION_JOURNAL_REFUSED: ${message}`)
}

function validatePayload(kind, payload) {
  const common = [
    'version',
    'operationId',
    'tenantId',
    'venueId',
    'sessionId',
    'requestSha256',
    'policyVersion',
    'policySha256',
    'effectiveCutoffUtc',
    'affected',
  ]
  const keys = [
    ...common,
    ...(kind === 'INTENT'
      ? ['request', 'authority', 'retiredTokenDigest']
      : ['externalIntentSha256']),
  ].sort()
  if (
    !payload ||
    Object.keys(payload).sort().join(',') !== keys.join(',') ||
    payload.version !==
      (kind === 'INTENT' ? 'guest-disposition-intent-v1' : 'guest-disposition-db-receipt-v1') ||
    !operationPattern.test(payload.operationId ?? '') ||
    ['tenantId', 'venueId', 'sessionId'].some(
      (key) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/u.test(payload[key] ?? ''),
    ) ||
    !digestPattern.test(payload.requestSha256 ?? '') ||
    !digestPattern.test(payload.policySha256 ?? '') ||
    !/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(payload.policyVersion ?? '') ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/u.test(
      payload.effectiveCutoffUtc ?? '',
    ) ||
    !Number.isFinite(Date.parse(payload.effectiveCutoffUtc))
  )
    refuse('invalid content-free payload')
  const counts = payload.affected
  if (
    !counts ||
    Object.keys(counts).sort().join(',') !==
      'analyticsEvents,engagementResponses,feedback,messages,sessions,turns' ||
    counts.sessions !== 1 ||
    Object.values(counts).some(
      (value) => !Number.isSafeInteger(value) || value < 0 || value > 10000,
    )
  )
    refuse('invalid counts')
  if (kind === 'INTENT') {
    const request = GuestConversationDispositionRequest.parse(payload.request)
    const authority = GuestConversationDispositionAuthoritySnapshot.parse(payload.authority)
    if (
      ['operationId', 'tenantId', 'venueId', 'sessionId'].some(
        (key) => request[key] !== payload[key],
      ) ||
      authority.policySha256 !== payload.policySha256 ||
      request.expectedPolicySha256 !== payload.policySha256 ||
      authority.policyVersion !== payload.policyVersion ||
      request.expectedPolicyVersion !== payload.policyVersion ||
      !digestPattern.test(payload.retiredTokenDigest ?? '')
    )
      refuse('intent authority/scope mismatch')
  } else if (!digestPattern.test(payload.externalIntentSha256 ?? ''))
    refuse('invalid external intent digest')
}

async function regularJournal(path) {
  const absolute = resolve(path)
  const info = await lstat(absolute)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES)
    refuse('unsafe journal file')
  if (resolve(await realpath(absolute)) !== absolute) refuse('journal path traverses a link')
  return absolute
}

/** Initialization is explicit and separate from erasure. An existing file is
 * never reset. Keep this operator-owned file outside every database/restore tree.
 * Filesystem custody and backup remain execution prerequisites, not claims made
 * by fsync or a successful same-disk readback.
 */
export async function initializeDispositionJournal(path) {
  const absolute = resolve(path)
  if (resolve(await realpath(dirname(absolute))) !== dirname(absolute)) refuse('unsafe parent')
  const file = await open(absolute, 'wx', 0o600)
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  return { path: absolute, records: 0, headSha256: ZERO }
}

function parseRecords(raw) {
  if (raw.length > MAX_BYTES || (raw.length && raw.at(-1) !== 10))
    refuse('oversized or partial journal')
  const records = []
  const intents = new Map()
  const completions = new Map()
  let previous = ZERO
  for (const line of raw.length ? raw.toString('utf8').split('\n').slice(0, -1) : []) {
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) refuse('oversized record')
    let record
    try {
      record = JSON.parse(line)
    } catch {
      refuse('invalid record')
    }
    if (
      Object.keys(record).sort().join(',') !==
        'kind,operationId,payload,payloadSha256,previousSha256,sequence,version' ||
      record.version !== 'guest-disposition-journal-v1' ||
      record.sequence !== records.length + 1 ||
      record.previousSha256 !== previous ||
      !operationPattern.test(record.operationId) ||
      !['INTENT', 'COMPLETION'].includes(record.kind) ||
      !digestPattern.test(record.payloadSha256) ||
      dispositionSha256(record.payload) !== record.payloadSha256 ||
      canonicalDispositionJson(record) !== line
    )
      refuse('record identity/hash/chain mismatch')
    if (record.payload?.operationId !== record.operationId) refuse('payload scope mismatch')
    validatePayload(record.kind, record.payload)
    if (record.kind === 'INTENT') {
      if (intents.has(record.operationId)) refuse('duplicate intent')
      intents.set(record.operationId, record)
    } else {
      const intent = intents.get(record.operationId)
      if (
        !intent ||
        completions.has(record.operationId) ||
        record.payload.externalIntentSha256 !== intent.payloadSha256 ||
        [
          'tenantId',
          'venueId',
          'sessionId',
          'requestSha256',
          'policyVersion',
          'policySha256',
          'effectiveCutoffUtc',
        ].some((key) => record.payload[key] !== intent.payload[key]) ||
        canonicalDispositionJson(record.payload.affected) !==
          canonicalDispositionJson(intent.payload.affected)
      )
        refuse('completion does not match intent')
      completions.set(record.operationId, record)
    }
    previous = dispositionSha256(line)
    records.push(record)
  }
  return { records, intents, completions, headSha256: previous, bytes: raw.length }
}

/** A separately retained current high-water binding is mandatory. The restored
 * database cannot establish whether this external journal is complete.
 */
export async function readDispositionJournal(path, expectedHeadSha256) {
  if (!digestPattern.test(expectedHeadSha256 ?? '')) refuse('expected high-water missing')
  const absolute = await regularJournal(path)
  const file = await open(absolute, 'r')
  let raw
  try {
    raw = await file.readFile()
  } finally {
    await file.close()
  }
  const journal = parseRecords(raw)
  if (journal.headSha256 !== expectedHeadSha256) refuse('high-water mismatch')
  return journal
}

/** Append to an already-created file, fsync, then verify exact bytes. A separate
 * exclusive lock refuses concurrent/stale writers. On any uncertain write the
 * lock is retained; no truncation, automatic retry or invented completion occurs.
 */
export async function appendDispositionJournal(path, expectedHeadSha256, kind, payload) {
  if (!['INTENT', 'COMPLETION'].includes(kind)) refuse('invalid kind')
  validatePayload(kind, payload)
  const absolute = await regularJournal(path)
  const lockPath = `${absolute}.writer-lock`
  const lock = await open(lockPath, 'wx', 0o600)
  let success = false
  try {
    await lock.writeFile(
      canonicalDispositionJson({
        version: 1,
        expectedHeadSha256,
        operationId: payload.operationId,
      }) + '\n',
    )
    await lock.sync()
    const journal = await readDispositionJournal(absolute, expectedHeadSha256)
    const previousRecord = (kind === 'INTENT' ? journal.intents : journal.completions).get(
      payload.operationId,
    )
    if (previousRecord) {
      if (previousRecord.payloadSha256 !== dispositionSha256(payload))
        refuse('same-operation conflict')
      success = true
      return { ...journal, replayed: true, payloadSha256: previousRecord.payloadSha256 }
    }
    const record = {
      version: 'guest-disposition-journal-v1',
      sequence: journal.records.length + 1,
      previousSha256: expectedHeadSha256,
      operationId: payload.operationId,
      kind,
      payloadSha256: dispositionSha256(payload),
      payload,
    }
    const encoded = Buffer.from(canonicalDispositionJson(record) + '\n')
    if (encoded.length > MAX_RECORD_BYTES || journal.bytes + encoded.length > MAX_BYTES)
      refuse('journal cap')
    // Validate the entire prospective chain before any append.
    const existing = Buffer.from(
      journal.records
        .map(canonicalDispositionJson)
        .map((line) => line + '\n')
        .join(''),
    )
    const expected = Buffer.concat([existing, encoded])
    const next = parseRecords(expected)
    const file = await open(absolute, 'a')
    try {
      await file.writeFile(encoded)
      await file.sync()
    } finally {
      await file.close()
    }
    const actual = await open(absolute, 'r')
    let readback
    try {
      readback = await actual.readFile()
    } finally {
      await actual.close()
    }
    if (!readback.equals(expected)) refuse('append readback mismatch')
    success = true
    return { ...next, replayed: false, payloadSha256: record.payloadSha256 }
  } finally {
    await lock.close()
    if (success) {
      // Only this invocation's exact lock is removed; never a journal record.
      const { unlink } = await import('node:fs/promises')
      await unlink(lockPath)
    }
  }
}
