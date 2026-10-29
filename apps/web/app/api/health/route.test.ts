import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dependencyMocks = vi.hoisted(() => ({
  checkDatabase: vi.fn(),
  checkQueue: vi.fn(),
  readGeneration: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  checkDatabaseConnection: dependencyMocks.checkDatabase,
}))

vi.mock('@pathfinder/jobs', () => ({
  checkBullMQConnection: dependencyMocks.checkQueue,
  readGenerationHealth: dependencyMocks.readGeneration,
}))

import { GET } from './route'

beforeEach(() => {
  dependencyMocks.checkDatabase.mockReset().mockResolvedValue(1)
  dependencyMocks.checkQueue.mockReset().mockResolvedValue('PONG')
  dependencyMocks.readGeneration.mockReset().mockResolvedValue({ status: 'unknown', lastFailureCode: null, since: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('health route', () => {
  it('reports passive billing degradation without changing infrastructure readiness', async () => {
    dependencyMocks.readGeneration.mockResolvedValue({ status: 'degraded', lastFailureCode: 'PROVIDER_CREDITS_EXHAUSTED', since: '2026-10-29T05:30:00.000Z' })
    const response = await GET()
    expect(response.status).toBe(200)
    expect((await response.json()).generation).toEqual({ status: 'degraded', lastFailureCode: 'PROVIDER_CREDITS_EXHAUSTED', since: '2026-10-29T05:30:00.000Z' })
  })

  it('bounds unavailable passive observation independently of infrastructure checks', async () => {
    vi.useFakeTimers()
    dependencyMocks.readGeneration.mockImplementation(() => new Promise(() => undefined))
    const pending = GET()
    await vi.advanceTimersByTimeAsync(250)
    const response = await pending
    expect(response.status).toBe(200)
    expect((await response.json()).generation).toEqual({ status: 'unknown', lastFailureCode: null, since: null })
  })

  it('contains observation read failure without leaking its error', async () => {
    dependencyMocks.readGeneration.mockRejectedValue(new Error('private upstream response'))
    const response = await GET()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.generation).toEqual({ status: 'unknown', lastFailureCode: null, since: null })
    expect(JSON.stringify(body)).not.toContain('private upstream response')
  })
  it('returns 200 only when every required dependency is up', async () => {
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toMatchObject({
      ok: true,
      deps: {
        db: 'up',
        queue: 'up',
      },
    })
    expect(body.deployment).toEqual({
      environment: expect.any(String),
      revision: expect.any(String),
      resources: {
        database: expect.any(String),
        redis: expect.any(String),
        storage: expect.any(String),
      },
    })
    expect(dependencyMocks.checkDatabase).toHaveBeenCalledWith(2_000)
    expect(dependencyMocks.checkQueue).toHaveBeenCalledWith(2_000)
  })

  it.each(['database', 'queue'])('returns 503 when the %s check fails', async (dependency) => {
    if (dependency === 'database') {
      dependencyMocks.checkDatabase.mockRejectedValue(new Error('database unavailable'))
    } else {
      dependencyMocks.checkQueue.mockRejectedValue(new Error('queue unavailable'))
    }

    const response = await GET()

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json()).ok).toBe(false)
  })

  it('bounds dependency checks and reports a timeout as unavailable', async () => {
    vi.useFakeTimers()
    dependencyMocks.checkDatabase.mockImplementation(() => new Promise(() => undefined))

    const responsePromise = GET()
    await vi.advanceTimersByTimeAsync(2_000)
    const response = await responsePromise

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      ok: false,
      deps: {
        db: 'timeout',
        queue: 'up',
      },
    })
  })

  it('bounds a queue check even if the client ignores its deadline', async () => {
    vi.useFakeTimers()
    dependencyMocks.checkQueue.mockImplementation(() => new Promise(() => undefined))

    const responsePromise = GET()
    await vi.advanceTimersByTimeAsync(2_000)
    const response = await responsePromise

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      ok: false,
      deps: {
        db: 'up',
        queue: 'timeout',
      },
    })
  })

  it('exposes deployment identity without leaking unrelated environment data', async () => {
    const body = await (await GET()).json()

    expect(Object.keys(body.deployment).sort()).toEqual(['environment', 'resources', 'revision'])
    expect(Object.keys(body.deployment.resources).sort()).toEqual(['database', 'redis', 'storage'])
    expect(JSON.stringify(body)).not.toContain('DATABASE_URL')
    expect(JSON.stringify(body)).not.toContain('REDIS_URL')
  })
})
