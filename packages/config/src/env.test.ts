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
  DATABASE_RESOURCE_ID: 'db-staging-example',
  REDIS_RESOURCE_ID: 'redis-staging-example',
  WORKER_SCHEDULERS_ENABLED: 'false',
  OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
  EMBEDDING_DISPATCH_ENABLED: 'false',
  GENERATION_DISPATCH_ENABLED: 'false',
  GENERATION_RECOVERY_ENABLED: 'false',
  EVALUATION_RUNNER_ENABLED: 'false',
}

const stagingResourceIdentity = {
  DATABASE_RESOURCE_ID: 'db-staging-example',
  REDIS_RESOURCE_ID: 'redis-staging-example',
}

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv
})

describe('RAILWAY_ENVIRONMENT', () => {
  it('defaults to staging outside production', () => {
    process.env.NODE_ENV = 'test'

    expect(
      envSchema.parse({ ...requiredEnvironment, ...stagingResourceIdentity }).RAILWAY_ENVIRONMENT,
    ).toBe('staging')
  })

  it('is required in production', () => {
    process.env.NODE_ENV = 'production'

    expect(() => envSchema.parse(requiredEnvironment)).toThrow()
  })

  it('accepts the supported deployment environments', () => {
    process.env.NODE_ENV = 'production'

    for (const RAILWAY_ENVIRONMENT of ['production', 'staging', 'preview']) {
      expect(
        envSchema.parse({
          ...requiredEnvironment,
          ...(RAILWAY_ENVIRONMENT === 'staging' ? stagingResourceIdentity : {}),
          RAILWAY_ENVIRONMENT,
        }).RAILWAY_ENVIRONMENT,
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
        envSchema.parse({
          ...requiredEnvironment,
          ...(RAILWAY_ENVIRONMENT === 'staging' ? stagingResourceIdentity : {}),
          REDIS_URL: undefined,
          RAILWAY_ENVIRONMENT,
        }).REDIS_URL,
      ).toBeUndefined()
    },
  )

  it('requires non-secret database and Redis resource identities in staging', () => {
    process.env.NODE_ENV = 'production'
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        DATABASE_RESOURCE_ID: undefined,
        REDIS_RESOURCE_ID: undefined,
        RAILWAY_ENVIRONMENT: 'staging',
      }),
    ).toThrow('DATABASE_RESOURCE_ID is required in staging')
    expect(
      envSchema.parse({
        ...requiredEnvironment,
        ...stagingResourceIdentity,
        RAILWAY_ENVIRONMENT: 'staging',
      }),
    ).toMatchObject(stagingResourceIdentity)
  })
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
  it('never defaults background work on in the shared schema', () => {
    process.env.NODE_ENV = 'production'

    expect(
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'production',
        WORKER_SCHEDULERS_ENABLED: undefined,
      }).WORKER_SCHEDULERS_ENABLED,
    ).toBe(false)
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
          OUTBOUND_PROVIDER_WORKERS_ENABLED:
            WORKER_SCHEDULERS_ENABLED === 'true' ? 'true' : 'false',
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

describe('OUTBOUND_PROVIDER_WORKERS_ENABLED', () => {
  it.each(['production', 'staging', 'preview'] as const)(
    'defaults disabled in the shared schema for %s',
    (RAILWAY_ENVIRONMENT) => {
      expect(
        envSchema.parse({
          ...requiredEnvironment,
          RAILWAY_ENVIRONMENT,
          OUTBOUND_PROVIDER_WORKERS_ENABLED: undefined,
        }).OUTBOUND_PROVIDER_WORKERS_ENABLED,
      ).toBe(false)
    },
  )

  it('accepts only an exact explicit enable value', () => {
    expect(
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'true',
      }).OUTBOUND_PROVIDER_WORKERS_ENABLED,
    ).toBe(true)
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'yes',
      }),
    ).toThrow()
  })
})

describe('operational alert delivery environment', () => {
  it('defaults both delivery routes off', () => {
    expect(envSchema.parse(requiredEnvironment)).toMatchObject({
      OPERATIONAL_ALERT_DELIVERY_ENABLED: false,
      OPERATIONAL_ALERT_DEV_SINK_ENABLED: false,
    })
  })

  it('requires an explicit complete provider route before external delivery can activate', () => {
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        OPERATIONAL_ALERT_DELIVERY_ENABLED: 'true',
      }),
    ).toThrow('RESEND_API_KEY is required when operational alert delivery is enabled')

    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'true',
        OPERATIONAL_ALERT_DELIVERY_ENABLED: 'true',
        OPERATIONAL_ALERT_EMAIL_TO: 'operator@example.test',
        RESEND_API_KEY: 'test-provider-key',
        RESEND_FROM_EMAIL: 'alerts@example.test',
      }),
    ).not.toThrow()
  })

  it('rejects invalid, ambiguous, or production development-sink activation', () => {
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'true',
        OPERATIONAL_ALERT_DELIVERY_ENABLED: 'true',
        OPERATIONAL_ALERT_EMAIL_TO: 'operator@example.test',
        RESEND_API_KEY: 'test-provider-key',
        RESEND_FROM_EMAIL: 'not-an-email',
      }),
    ).toThrow()

    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'true',
        OPERATIONAL_ALERT_DELIVERY_ENABLED: 'true',
        OPERATIONAL_ALERT_DEV_SINK_ENABLED: 'true',
        OPERATIONAL_ALERT_EMAIL_TO: 'operator@example.test',
        RESEND_API_KEY: 'test-provider-key',
        RESEND_FROM_EMAIL: 'alerts@example.test',
      }),
    ).toThrow('Choose either external operational alert delivery or the development sink')

    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'production',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'true',
        OPERATIONAL_ALERT_DEV_SINK_ENABLED: 'true',
      }),
    ).toThrow('forbidden in production')
  })
})

describe('Stripe Billing environment', () => {
  it('defaults every billing gate off in test mode', () => {
    const parsed = envSchema.parse(requiredEnvironment)
    expect(parsed).toMatchObject({
      STRIPE_MODE: 'test',
      STRIPE_BILLING_UI_ENABLED: false,
      STRIPE_CHECKOUT_ENABLED: false,
      STRIPE_CUSTOMER_PORTAL_ENABLED: false,
      STRIPE_WEBHOOK_PROCESSING_ENABLED: false,
      STRIPE_RECONCILIATION_ENABLED: false,
      BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED: false,
      STRIPE_LIVE_MODE_ALLOWED: false,
    })
  })

  it('rejects a live key in test mode', () => {
    expect(() =>
      envSchema.parse({ ...requiredEnvironment, STRIPE_SECRET_KEY: 'sk_live_wrong-mode' }),
    ).toThrow('sk_test_')
  })

  it('accepts a restricted key in test mode', () => {
    expect(() =>
      envSchema.parse({ ...requiredEnvironment, STRIPE_SECRET_KEY: 'rk_test_example' }),
    ).not.toThrow()
  })

  it('rejects live mode outside production and without the explicit kill switch', () => {
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        STRIPE_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_example',
        STRIPE_LIVE_MODE_ALLOWED: 'true',
        RAILWAY_ENVIRONMENT: 'staging',
      }),
    ).toThrow('forbidden outside production')
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        STRIPE_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_example',
        RAILWAY_ENVIRONMENT: 'production',
      }),
    ).toThrow('STRIPE_LIVE_MODE_ALLOWED=true')
  })
})

describe('EMBEDDING_DISPATCH_ENABLED', () => {
  it('never defaults enabled in the shared schema', () => {
    expect(
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'production',
        EMBEDDING_DISPATCH_ENABLED: undefined,
      }).EMBEDDING_DISPATCH_ENABLED,
    ).toBe(false)
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
      OUTBOUND_PROVIDER_WORKERS_ENABLED: 'true',
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
      OUTBOUND_PROVIDER_WORKERS_ENABLED: 'true',
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

describe('AGENT_BRIDGE_HTTP_ENABLED', () => {
  it.each(['production', 'staging', 'preview'] as const)(
    'defaults to disabled in %s',
    (RAILWAY_ENVIRONMENT) => {
      expect(
        envSchema.parse({ ...requiredEnvironment, RAILWAY_ENVIRONMENT }).AGENT_BRIDGE_HTTP_ENABLED,
      ).toBe(false)
    },
  )

  it('accepts only an exact explicit enable value', () => {
    expect(
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        AGENT_BRIDGE_HTTP_ENABLED: 'true',
      }).AGENT_BRIDGE_HTTP_ENABLED,
    ).toBe(true)
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        AGENT_BRIDGE_HTTP_ENABLED: 'yes',
      }),
    ).toThrow()
  })
})

describe('EVALUATION_RUNNER_ENABLED', () => {
  it.each(['production', 'staging', 'preview'] as const)(
    'defaults to disabled in %s',
    (RAILWAY_ENVIRONMENT) => {
      expect(
        envSchema.parse({ ...requiredEnvironment, RAILWAY_ENVIRONMENT }).EVALUATION_RUNNER_ENABLED,
      ).toBe(false)
    },
  )

  it('requires an exact explicit enable value', () => {
    expect(
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        OUTBOUND_PROVIDER_WORKERS_ENABLED: 'true',
        EVALUATION_RUNNER_ENABLED: 'true',
      }).EVALUATION_RUNNER_ENABLED,
    ).toBe(true)
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        EVALUATION_RUNNER_ENABLED: 'yes',
      }),
    ).toThrow()
  })
})

describe('GENERATION_DISPATCH_ENABLED', () => {
  it('never defaults enabled in the shared schema', () => {
    expect(
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'production',
        GENERATION_DISPATCH_ENABLED: undefined,
      }).GENERATION_DISPATCH_ENABLED,
    ).toBe(false)
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
      OUTBOUND_PROVIDER_WORKERS_ENABLED: 'true',
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

describe('WIDGET_PREVIEW_ORIGINS_JSON', () => {
  it('is optional and bounds the raw server-only policy', () => {
    expect(
      envSchema.parse({ ...requiredEnvironment, RAILWAY_ENVIRONMENT: 'staging' })
        .WIDGET_PREVIEW_ORIGINS_JSON,
    ).toBeUndefined()
    expect(
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        WIDGET_PREVIEW_ORIGINS_JSON: '{}',
      }).WIDGET_PREVIEW_ORIGINS_JSON,
    ).toBe('{}')
    expect(() =>
      envSchema.parse({
        ...requiredEnvironment,
        RAILWAY_ENVIRONMENT: 'staging',
        WIDGET_PREVIEW_ORIGINS_JSON: 'x'.repeat(16_385),
      }),
    ).toThrow()
  })
})
