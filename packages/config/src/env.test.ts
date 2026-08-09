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

describe('error monitoring environment', () => {
  it('accepts only explicit boolean enable values and a valid DSN', () => {
    expect(
      envSchema.parse({
        ...requiredEnvironment,
        SENTRY_DSN: 'https://public@example.test/1',
        SENTRY_ENABLED: 'true',
      }),
    ).toMatchObject({ SENTRY_DSN: 'https://public@example.test/1', SENTRY_ENABLED: 'true' })

    expect(() => envSchema.parse({ ...requiredEnvironment, SENTRY_ENABLED: 'yes' })).toThrow()
    expect(() => envSchema.parse({ ...requiredEnvironment, SENTRY_DSN: 'not-a-url' })).toThrow()
  })
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

describe('EMBEDDING_DISPATCH_ENABLED', () => {
  it('defaults to enabled in production', () => {
    expect(
      envSchema.parse({ ...requiredEnvironment, RAILWAY_ENVIRONMENT: 'production' })
        .EMBEDDING_DISPATCH_ENABLED,
    ).toBe(true)
  })

  it.each(['staging', 'preview'] as const)('defaults to disabled in %s', (RAILWAY_ENVIRONMENT) => {
    expect(
      envSchema.parse({ ...requiredEnvironment, RAILWAY_ENVIRONMENT }).EMBEDDING_DISPATCH_ENABLED,
    ).toBe(false)
  })

  it('allows an explicit staging enable without enabling business schedulers', () => {
    const parsed = envSchema.parse({
      ...requiredEnvironment,
      RAILWAY_ENVIRONMENT: 'staging',
      EMBEDDING_DISPATCH_ENABLED: 'true',
    })
    expect(parsed.EMBEDDING_DISPATCH_ENABLED).toBe(true)
    expect(parsed.WORKER_SCHEDULERS_ENABLED).toBe(false)
  })

  it('rejects an invalid dispatch override', () => {
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        EMBEDDING_DISPATCH_ENABLED: 'yes',
      }),
    ).toThrow()
  })
})

describe('GENERATION_RECOVERY_ENABLED', () => {
  it.each(['production', 'staging', 'preview'] as const)(
    'defaults to disabled in %s until explicitly rolled out',
    (RAILWAY_ENVIRONMENT) => {
      expect(
        envSchema.parse({ ...requiredEnvironment, RAILWAY_ENVIRONMENT })
          .GENERATION_RECOVERY_ENABLED,
      ).toBe(false)
    },
  )

  it('allows an explicit staging enable without enabling business schedulers', () => {
    const parsed = envSchema.parse({
      ...requiredEnvironment,
      RAILWAY_ENVIRONMENT: 'staging',
      GENERATION_RECOVERY_ENABLED: 'true',
    })
    expect(parsed.GENERATION_RECOVERY_ENABLED).toBe(true)
    expect(parsed.WORKER_SCHEDULERS_ENABLED).toBe(false)
  })

  it('rejects an invalid recovery override', () => {
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        GENERATION_RECOVERY_ENABLED: 'yes',
      }),
    ).toThrow()
  })
})

describe('GENERATION_DISPATCH_ENABLED', () => {
  it('defaults to enabled in production', () => {
    expect(
      envSchema.parse({ ...requiredEnvironment, RAILWAY_ENVIRONMENT: 'production' })
        .GENERATION_DISPATCH_ENABLED,
    ).toBe(true)
  })

  it.each(['staging', 'preview'] as const)('defaults to disabled in %s', (RAILWAY_ENVIRONMENT) => {
    expect(
      envSchema.parse({ ...requiredEnvironment, RAILWAY_ENVIRONMENT }).GENERATION_DISPATCH_ENABLED,
    ).toBe(false)
  })

  it('allows an explicit staging enable without enabling business schedulers or recovery', () => {
    const parsed = envSchema.parse({
      ...requiredEnvironment,
      RAILWAY_ENVIRONMENT: 'staging',
      GENERATION_DISPATCH_ENABLED: 'true',
    })
    expect(parsed.GENERATION_DISPATCH_ENABLED).toBe(true)
    expect(parsed.WORKER_SCHEDULERS_ENABLED).toBe(false)
    expect(parsed.GENERATION_RECOVERY_ENABLED).toBe(false)
  })

  it('rejects an invalid generation dispatch override', () => {
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        GENERATION_DISPATCH_ENABLED: 'yes',
      }),
    ).toThrow()
  })
})

describe('EMBED_PREVIEW_ENABLED', () => {
  it('defaults to disabled in every deployment environment', () => {
    for (const RAILWAY_ENVIRONMENT of ['production', 'staging', 'preview'] as const) {
      expect(
        envSchema.parse({ ...requiredEnvironment, RAILWAY_ENVIRONMENT }).EMBED_PREVIEW_ENABLED,
      ).toBe(false)
    }
  })

  it('requires an exact explicit enable value', () => {
    expect(
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        EMBED_PREVIEW_ENABLED: 'true',
      }).EMBED_PREVIEW_ENABLED,
    ).toBe(true)
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        EMBED_PREVIEW_ENABLED: 'yes',
      }),
    ).toThrow()
  })
})
