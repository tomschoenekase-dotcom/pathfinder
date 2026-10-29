import { createHash } from 'node:crypto'

import IORedis from 'ioredis'

import { env } from '@pathfinder/config'

const WINDOW_MS = 5 * 60_000
const TTL_MS = 15 * 60_000
const IO_TIMEOUT_MS = 200
const MAX_MODELS = 64
const MAX_RECORD_BYTES = 4_096

export type GenerationHealth = {
  status: 'healthy' | 'degraded' | 'unknown'
  lastFailureCode: string | null
  since: string | null
}

export type GenerationOutcome = {
  provider: string
  model: string
  invocationId: string
  success: boolean
  failureCode?: string
  at?: Date
}

type Outcome = { id: string; at: number; success: boolean; failureCode: string | null }
export type GenerationHealthRecord = {
  version: 1
  updatedAt: number
  outcomes: Outcome[]
  degradedSince: number | null
  lastFailureCode: string | null
}

const UNKNOWN: GenerationHealth = { status: 'unknown', lastFailureCode: null, since: null }
const SAFE_CODES = new Set([
  'PROVIDER_CREDITS_EXHAUSTED', 'PROVIDER_UNKNOWN', 'PROVIDER_RATE_LIMITED', 'PROVIDER_TIMEOUT',
  'PROVIDER_CONNECTION_FAILED', 'PROVIDER_UNAVAILABLE',
  'PROVIDER_NOT_CONFIGURED', 'PROVIDER_AUTHENTICATION_FAILED',
])

function safeCode(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CODES.has(value)
}

// Dispatch validates the model against the central AI registry. This boundary only
// bounds identifiers; hashed fields avoid duplicating registry policy or storing model text.
const PROVIDERS = new Set(['openai', 'anthropic', 'deepseek'])

/** Strictly bounded parsing: stored data is evidence, never trusted instructions or error text. */
export function parseGenerationHealthRecord(raw: string | null): GenerationHealthRecord | null {
  if (!raw || raw.length > MAX_RECORD_BYTES) return null
  try {
    const value = JSON.parse(raw) as GenerationHealthRecord
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 ||
      !Array.isArray(value.outcomes) || value.outcomes.length < 1 || value.outcomes.length > 5 ||
      !(value.degradedSince === null || (Number.isSafeInteger(value.degradedSince) && value.degradedSince >= 0 && value.degradedSince <= value.updatedAt)) ||
      !(value.lastFailureCode === null || safeCode(value.lastFailureCode))) return null
    let previous = -1
    const ids = new Set<string>()
    for (const outcome of value.outcomes) {
      if (!outcome || !/^[a-f0-9]{64}$/u.test(outcome.id) || ids.has(outcome.id) ||
        !Number.isSafeInteger(outcome.at) || outcome.at < previous || outcome.at > value.updatedAt ||
        typeof outcome.success !== 'boolean' ||
        (outcome.success ? outcome.failureCode !== null : !safeCode(outcome.failureCode))) return null
      previous = outcome.at
      ids.add(outcome.id)
    }
    if (previous !== value.updatedAt || (value.degradedSince !== null && value.lastFailureCode === null)) return null
    // Reconstruct only the allowed fields; unknown JSON properties never escape.
    return {
      version: 1, updatedAt: value.updatedAt,
      degradedSince: value.degradedSince, lastFailureCode: value.lastFailureCode,
      outcomes: value.outcomes.map(({ id, at, success, failureCode }) => ({ id, at, success, failureCode })),
    }
  } catch { return null }
}

/** Terminal invocations, not provider retries, count toward the rolling threshold. */
export function reduceGenerationHealthRecord(
  previous: GenerationHealthRecord | null,
  outcome: Outcome,
): GenerationHealthRecord {
  if (previous && (outcome.at < previous.updatedAt || previous.outcomes.some((entry) => entry.id === outcome.id))) return previous
  const active = previous && outcome.at - previous.updatedAt < TTL_MS ? previous : null
  let outcomes = [...(active?.outcomes ?? []).filter((entry) => outcome.at - entry.at <= WINDOW_MS), outcome].slice(-5)
  const trailingSuccess = outcomes.slice(-2).length === 2 && outcomes.slice(-2).every((entry) => entry.success)
  let degradedSince = active?.degradedSince ?? null
  let lastFailureCode = active?.lastFailureCode ?? null
  if (trailingSuccess) {
    // Recovery starts a fresh error sample; old incident failures cannot immediately
    // re-trigger degradation after one later isolated failure.
    outcomes = outcomes.slice(-2)
    degradedSince = null
    lastFailureCode = null
  } else if (!outcome.success && (outcome.failureCode === 'PROVIDER_CREDITS_EXHAUSTED' || outcomes.filter((entry) => !entry.success).length >= 3)) {
    degradedSince ??= outcome.at
    lastFailureCode = outcome.failureCode
  } else if (!outcome.success && degradedSince !== null) {
    lastFailureCode = outcome.failureCode
  }
  return { version: 1, updatedAt: outcome.at, outcomes, degradedSince, lastFailureCode }
}

function key(): string { return `torchiko:generation-health:v1:${env.RAILWAY_ENVIRONMENT}` }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

// CAS keeps the reducer testable while Redis serializes competing host writes. No unbounded WATCH loop.
const UPDATE_SCRIPT = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if (current or '') ~= ARGV[2] then return 0 end
if not current and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[5]) then return -1 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`

async function boundedRedis<T>(operation: (connection: IORedis) => Promise<T>): Promise<T | undefined> {
  if (!env.REDIS_URL) return undefined
  let connection: IORedis | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    connection = new IORedis(env.REDIS_URL, {
      commandTimeout: IO_TIMEOUT_MS - 20, connectTimeout: IO_TIMEOUT_MS - 20,
      enableOfflineQueue: false, enableReadyCheck: false, lazyConnect: true,
      maxRetriesPerRequest: 0, retryStrategy: () => null,
    })
    connection.on('error', () => undefined)
    const client = connection
    return await Promise.race([
      (async () => { await client.connect(); return operation(client) })(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), IO_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } catch { return undefined } finally {
    if (timer) clearTimeout(timer)
    connection?.disconnect()
  }
}

/** Best effort only. Callers may schedule this after their durable answer; never use it as an admission gate. */
export async function recordGenerationOutcome(input: GenerationOutcome): Promise<void> {
  try {
    if (!PROVIDERS.has(input.provider) || typeof input.model !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u.test(input.model) ||
      typeof input.invocationId !== 'string' || input.invocationId.length < 1 || input.invocationId.length > 191 ||
      typeof input.success !== 'boolean') return
    const now = Date.now()
    const at = input.at?.getTime() ?? now
    if (!Number.isSafeInteger(at) || at > now + 5_000 || at <= now - TTL_MS) return
    const outcome: Outcome = {
      id: digest(input.invocationId), at, success: input.success,
      failureCode: input.success ? null : safeCode(input.failureCode) ? input.failureCode : 'PROVIDER_UNKNOWN',
    }
    const field = digest(`${input.provider}\n${input.model}`)
    await boundedRedis(async (connection) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const raw = await connection.hget(key(), field)
        const previous = parseGenerationHealthRecord(raw)
        const next = reduceGenerationHealthRecord(previous, outcome)
        if (next === previous) return
        const result = await connection.eval(UPDATE_SCRIPT, 1, key(), field, raw ?? '', JSON.stringify(next), TTL_MS, MAX_MODELS)
        if (result !== 0) return
      }
    })
  } catch { /* Observation must never change the answer or throw a provider exception. */ }
}

/** Passive aggregate only; absence, expiry and unavailable/malformed storage never imply healthy. */
export async function readGenerationHealth(): Promise<GenerationHealth> {
  const now = Date.now()
  const records = await boundedRedis(async (connection) => {
    if (await connection.hlen(key()) > MAX_MODELS) return undefined
    return connection.hvals(key())
  })
  if (!records || records.length === 0) return { ...UNKNOWN }
  let malformed = false
  const active: GenerationHealthRecord[] = []
  for (const raw of records) {
    const value = parseGenerationHealthRecord(raw)
    if (!value || value.updatedAt > now + 5_000) { malformed = true; continue }
    if (now - value.updatedAt < TTL_MS) active.push(value)
  }
  const degraded = active.filter((record) => record.degradedSince !== null)
  if (degraded.length > 0) {
    const latest = degraded.reduce((left, right) => left.updatedAt >= right.updatedAt ? left : right)
    return { status: 'degraded', lastFailureCode: latest.lastFailureCode, since: new Date(Math.min(...degraded.map((record) => record.degradedSince!))).toISOString() }
  }
  return malformed || active.length === 0 ? { ...UNKNOWN } : { status: 'healthy', lastFailureCode: null, since: null }
}
