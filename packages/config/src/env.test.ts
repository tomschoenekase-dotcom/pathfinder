import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const originalNodeEnv = process.env.NODE_ENV
const originalNextPhase = process.env.NEXT_PHASE

let envSchema: typeof import('./env').envSchema

beforeAll(async () => {
  // The module validates process.env while it is imported. Use the existing
  // build-time escape hatch so these tests can exercise envSchema directly.
  process.env.NEXT_PHASE = 'phase-production-build'
  ;({ envSchema } = await import('./env'))
})

afterAll(() => {
  process.env.NEXT_PHASE = originalNextPhase
})

const requiredEnvironment = {
  DATABASE_URL: 'postgresql://example.test/pathfinder',
  DIRECT_DATABASE_URL: 'postgresql://example.test/pathfinder',
  CLERK_SECRET_KEY: 'test-secret',
  CLERK_PUBLISHABLE_KEY: 'test-publishable',
  REDIS_URL: 'redis://example.test:6379',
}

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv
})

describe('RAILWAY_ENVIRONMENT', () => {
  it('defaults to staging outside production', () => {
    process.env.NODE_ENV = 'test'

    expect(envSchema.parse(requiredEnvironment).RAILWAY_ENVIRONMENT).toBe('staging')
  })

  it('is required in production', () => {
    process.env.NODE_ENV = 'production'

    expect(() => envSchema.parse(requiredEnvironment)).toThrow()
  })

  it('accepts the supported deployment environments', () => {
    process.env.NODE_ENV = 'production'

    for (const RAILWAY_ENVIRONMENT of ['production', 'staging', 'preview']) {
      expect(
        envSchema.parse({ ...requiredEnvironment, RAILWAY_ENVIRONMENT }).RAILWAY_ENVIRONMENT,
      ).toBe(RAILWAY_ENVIRONMENT)
    }
  })

  it('requires Redis in production', () => {
    process.env.NODE_ENV = 'production'

    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        REDIS_URL: undefined,
        RAILWAY_ENVIRONMENT: 'production',
      }),
    ).toThrow('REDIS_URL is required in production')
  })

  it.each(['staging', 'preview'] as const)(
    'allows Redis to be omitted in %s',
    (RAILWAY_ENVIRONMENT) => {
      process.env.NODE_ENV = 'production'

      expect(
        envSchema.parse({ ...requiredEnvironment, REDIS_URL: undefined, RAILWAY_ENVIRONMENT })
          .REDIS_URL,
      ).toBeUndefined()
    },
  )
})

describe('WORKER_SCHEDULERS_ENABLED', () => {
  it('defaults to enabled in production', () => {
    process.env.NODE_ENV = 'production'

    expect(
      envSchema.parse({ ...requiredEnvironment, RAILWAY_ENVIRONMENT: 'production' })
        .WORKER_SCHEDULERS_ENABLED,
    ).toBe(true)
  })

  it.each(['staging', 'preview'] as const)('defaults to disabled in %s', (RAILWAY_ENVIRONMENT) => {
    process.env.NODE_ENV = 'production'

    expect(
      envSchema.parse({ ...requiredEnvironment, RAILWAY_ENVIRONMENT }).WORKER_SCHEDULERS_ENABLED,
    ).toBe(false)
  })

  it.each([
    ['production', 'false', false],
    ['staging', 'true', true],
    ['preview', 'true', true],
  ] as const)(
    'allows %s to explicitly set the scheduler override to %s',
    (RAILWAY_ENVIRONMENT, WORKER_SCHEDULERS_ENABLED, expected) => {
      process.env.NODE_ENV = 'production'

      expect(
        envSchema.parse({
          ...requiredEnvironment,
          RAILWAY_ENVIRONMENT,
          WORKER_SCHEDULERS_ENABLED,
        }).WORKER_SCHEDULERS_ENABLED,
      ).toBe(expected)
    },
  )

  it('rejects an invalid scheduler override', () => {
    process.env.NODE_ENV = 'production'

    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        WORKER_SCHEDULERS_ENABLED: 'yes',
      }),
    ).toThrow()
  })
})
