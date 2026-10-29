import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(),
  hget: vi.fn(), hlen: vi.fn(), hvals: vi.fn(), eval: vi.fn(),
  env: { REDIS_URL: 'redis://example.invalid:6379', RAILWAY_ENVIRONMENT: 'test' },
}))

vi.mock('@pathfinder/config', () => ({ env: mocks.env }))
vi.mock('ioredis', () => ({
  default: class {
    connect = mocks.connect
    disconnect = mocks.disconnect
    on = mocks.on
    hget = mocks.hget
    hlen = mocks.hlen
    hvals = mocks.hvals
    eval = mocks.eval
    constructor(...args: unknown[]) { mocks.constructor(...args) }
  },
}))

import { parseGenerationHealthRecord, readGenerationHealth, recordGenerationOutcome, reduceGenerationHealthRecord, type GenerationHealthRecord } from './generation-health'

const NOW = Date.parse('2026-10-29T05:30:00.000Z')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const outcome = (id: number, success: boolean, code = 'PROVIDER_UNKNOWN', at = NOW + id) => ({ id: digest(String(id)), at, success, failureCode: success ? null : code })
let stored: Map<string, string>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  for (const mock of Object.values(mocks)) if (vi.isMockFunction(mock)) mock.mockReset()
  mocks.env.RAILWAY_ENVIRONMENT = 'test'
  stored = new Map()
  mocks.connect.mockResolvedValue(undefined)
  mocks.on.mockReturnThis()
  mocks.hget.mockImplementation(async (_key: string, field: string) => stored.get(field) ?? null)
  mocks.hlen.mockImplementation(async () => stored.size)
  mocks.hvals.mockImplementation(async () => [...stored.values()])
  mocks.eval.mockImplementation(async (_script: string, _count: number, _key: string, field: string, expected: string, next: string) => {
    if ((stored.get(field) ?? '') !== expected) return 0
    stored.set(field, next)
    return 1
  })
})

afterEach(() => vi.useRealTimers())

describe('generation health rolling policy', () => {
  it('degrades immediately for billing and recovers only after two subsequent successes', () => {
    const failed = reduceGenerationHealthRecord(null, outcome(1, false, 'PROVIDER_CREDITS_EXHAUSTED'))
    expect(failed.degradedSince).toBe(NOW + 1)
    const once = reduceGenerationHealthRecord(failed, outcome(2, true))
    expect(once.degradedSince).toBe(NOW + 1)
    const twice = reduceGenerationHealthRecord(once, outcome(3, true))
    expect(twice).toMatchObject({ degradedSince: null, lastFailureCode: null })
  })

  it('requires three distinct failed invocations in the five minute rolling sample', () => {
    let record: GenerationHealthRecord | null = null
    for (let index = 1; index <= 2; index += 1) record = reduceGenerationHealthRecord(record, outcome(index, false))
    expect(record?.degradedSince).toBeNull()
    const duplicate = reduceGenerationHealthRecord(record, outcome(2, false))
    expect(duplicate).toBe(record)
    record = reduceGenerationHealthRecord(record, outcome(3, true))
    record = reduceGenerationHealthRecord(record, outcome(4, false))
    expect(record.degradedSince).toBe(NOW + 4)
    expect(record.outcomes).toHaveLength(4)
  })

  it('bounds the sample and drops failures outside five minutes', () => {
    let record: GenerationHealthRecord | null = null
    for (let index = 1; index <= 8; index += 1) record = reduceGenerationHealthRecord(record, outcome(index, true))
    expect(record?.outcomes).toHaveLength(2)
    record = reduceGenerationHealthRecord(record, outcome(9, false, 'PROVIDER_UNKNOWN', NOW + 300_009))
    expect(record.outcomes).toHaveLength(1)
    expect(record.degradedSince).toBeNull()
  })

  it('does not re-trigger a recovered incident from pre-recovery failures', () => {
    let record: GenerationHealthRecord | null = null
    for (let index = 1; index <= 3; index += 1) record = reduceGenerationHealthRecord(record, outcome(index, false))
    record = reduceGenerationHealthRecord(record, outcome(4, true))
    record = reduceGenerationHealthRecord(record, outcome(5, true))
    record = reduceGenerationHealthRecord(record, outcome(6, false))
    expect(record.degradedSince).toBeNull()
    expect(record.outcomes).toHaveLength(3)
  })

  it('does not allow late observations to roll back recovery or the clock', () => {
    const latest = reduceGenerationHealthRecord(null, outcome(10, true))
    expect(reduceGenerationHealthRecord(latest, outcome(1, false, 'PROVIDER_CREDITS_EXHAUSTED'))).toBe(latest)
  })

  it('does not inherit an incident after fifteen minutes without observations', () => {
    const old = reduceGenerationHealthRecord(null, outcome(1, false, 'PROVIDER_CREDITS_EXHAUSTED'))
    const fresh = reduceGenerationHealthRecord(old, outcome(2, true, 'PROVIDER_UNKNOWN', NOW + 900_001))
    expect(fresh).toMatchObject({ degradedSince: null, lastFailureCode: null })
    expect(fresh.outcomes).toHaveLength(1)
  })

  it('rejects malformed, raw-error, future-inconsistent and duplicate stored data', () => {
    const record = reduceGenerationHealthRecord(null, outcome(1, false, 'PROVIDER_CREDITS_EXHAUSTED'))
    for (const value of [null, 'not JSON', '{}', 'x'.repeat(4_097), JSON.stringify({ ...record, version: 2 }),
      JSON.stringify({ ...record, lastFailureCode: 'secret upstream message' }),
      JSON.stringify({ ...record, outcomes: [...record.outcomes, ...record.outcomes] }),
      JSON.stringify({ ...record, updatedAt: NOW })]) expect(parseGenerationHealthRecord(value)).toBeNull()
    expect(parseGenerationHealthRecord(JSON.stringify(record))).toEqual(record)
  })
})

describe('bounded passive Redis generation observations', () => {
  const write = (invocationId: string, success: boolean, failureCode?: string) => recordGenerationOutcome({ provider: 'openai', model: 'gpt-6.1-sol', invocationId, success, ...(failureCode ? { failureCode } : {}) })

  it('shares billing incidents through Redis and exposes only the safe aggregate', async () => {
    await write('one', false, 'PROVIDER_CREDITS_EXHAUSTED')
    expect(await readGenerationHealth()).toEqual({ status: 'degraded', lastFailureCode: 'PROVIDER_CREDITS_EXHAUSTED', since: new Date(NOW).toISOString() })
    await write('two', true)
    expect((await readGenerationHealth()).status).toBe('degraded')
    await write('three', true)
    expect(await readGenerationHealth()).toEqual({ status: 'healthy', lastFailureCode: null, since: null })
    expect(mocks.constructor).toHaveBeenCalledWith('redis://example.invalid:6379', expect.objectContaining({ enableOfflineQueue: false, maxRetriesPerRequest: 0, commandTimeout: 180, connectTimeout: 180 }))
    expect((mocks.constructor.mock.calls[0]![1] as { retryStrategy: () => unknown }).retryStrategy()).toBeNull()
    expect(mocks.disconnect).toHaveBeenCalledTimes(mocks.constructor.mock.calls.length)
    const raw = [...stored.values()][0]!
    expect(raw).not.toContain('one')
    expect(raw).not.toContain('gpt-6.1-sol')
  })

  it('does not mistake a single rate-limit failure for billing or sustained failure', async () => {
    await write('one', false, 'PROVIDER_RATE_LIMITED')
    expect((await readGenerationHealth()).status).toBe('healthy')
    await write('one', false, 'PROVIDER_RATE_LIMITED')
    expect(parseGenerationHealthRecord([...stored.values()][0]!)?.outcomes).toHaveLength(1)
  })

  it('normalizes unknown failure codes without retaining provider text', async () => {
    await write('one', false, 'private upstream message')
    expect([...stored.values()][0]).not.toContain('private upstream message')
    expect(parseGenerationHealthRecord([...stored.values()][0]!)?.outcomes[0]?.failureCode).toBe('PROVIDER_UNKNOWN')
  })

  it('isolates environments in its storage key', async () => {
    await write('one', true)
    expect(mocks.hget.mock.calls[0]?.[0]).toBe('torchiko:generation-health:v1:test')
    mocks.env.RAILWAY_ENVIRONMENT = 'staging'
    await write('two', true)
    expect(mocks.hget.mock.calls[1]?.[0]).toBe('torchiko:generation-health:v1:staging')
  })

  it('accepts future centrally validated model identifiers without storing their raw text', async () => {
    await recordGenerationOutcome({ provider: 'openai', model: 'future-model-2030', invocationId: 'future', success: true })
    expect((await readGenerationHealth()).status).toBe('healthy')
    expect(JSON.stringify([...stored])).not.toContain('future-model-2030')
    expect(mocks.hget.mock.calls[0]?.[1]).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('returns unknown for absent, expired, malformed and unavailable observations', async () => {
    expect((await readGenerationHealth()).status).toBe('unknown')
    await write('one', true)
    vi.setSystemTime(NOW + 900_000)
    expect((await readGenerationHealth()).status).toBe('unknown')
    stored.set('bad', 'private malformed value')
    expect((await readGenerationHealth()).status).toBe('unknown')
    mocks.connect.mockRejectedValue(new Error('private connection detail'))
    await expect(write('two', true)).resolves.toBeUndefined()
    expect((await readGenerationHealth()).status).toBe('unknown')
  })

  it('preserves a real degradation when another model succeeds', async () => {
    await write('one', false, 'PROVIDER_CREDITS_EXHAUSTED')
    await recordGenerationOutcome({ provider: 'deepseek', model: 'deepseek-flash', invocationId: 'two', success: true })
    expect((await readGenerationHealth()).status).toBe('degraded')
  })

  it('bounds stalled I/O and disconnects without changing the caller result', async () => {
    mocks.connect.mockImplementation(() => new Promise(() => undefined))
    const pending = write('one', true)
    await vi.advanceTimersByTimeAsync(200)
    await expect(pending).resolves.toBeUndefined()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    const read = readGenerationHealth()
    await vi.advanceTimersByTimeAsync(200)
    expect((await read).status).toBe('unknown')
  })

  it('retries a conflicting CAS from the current record rather than overwriting it', async () => {
    mocks.eval.mockResolvedValueOnce(0)
    await write('one', false, 'PROVIDER_CREDITS_EXHAUSTED')
    expect(mocks.hget).toHaveBeenCalledTimes(2)
    expect(mocks.eval).toHaveBeenCalledTimes(2)
    expect((await readGenerationHealth()).status).toBe('degraded')
  })

  it('retains simultaneous independent failures through CAS contention', async () => {
    await Promise.all([write('one', false), write('two', false), write('three', false)])
    expect(parseGenerationHealthRecord([...stored.values()][0]!)?.outcomes).toHaveLength(3)
    expect((await readGenerationHealth()).status).toBe('degraded')
    expect(mocks.eval.mock.calls[0]?.[6]).toBe(900_000)
    expect(mocks.eval.mock.calls[0]?.[0]).toContain("redis.call('PEXPIRE'")
  })

  it('stops after three CAS conflicts and rejects invalid or stale inputs before Redis', async () => {
    mocks.eval.mockResolvedValue(0)
    await write('one', true)
    expect(mocks.eval).toHaveBeenCalledTimes(3)
    mocks.constructor.mockClear()
    await recordGenerationOutcome({ provider: 'unknown', model: 'example', invocationId: 'one', success: true })
    await recordGenerationOutcome({ provider: 'openai', model: 'model\nprivate=metadata', invocationId: 'one', success: true })
    await recordGenerationOutcome({ provider: 'openai', model: 'gpt-6.1-sol', invocationId: 'one', success: true, at: new Date(NOW - 900_000) })
    await recordGenerationOutcome({ provider: 'openai', model: 'gpt-6.1-sol', invocationId: 'one', success: true, at: new Date(NOW + 5_001) })
    expect(mocks.constructor).not.toHaveBeenCalled()
  })
})
