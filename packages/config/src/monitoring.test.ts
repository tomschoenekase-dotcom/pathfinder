import { describe, expect, it } from 'vitest'

import {
  monitoringErrorMessage,
  resolveMonitoringContext,
  sanitizeMonitoringEvent,
} from './monitoring'

describe('resolveMonitoringContext', () => {
  it('is disabled unless both the explicit flag and matching DSN exist', () => {
    expect(resolveMonitoringContext({}, 'workers').enabled).toBe(false)
    expect(resolveMonitoringContext({ SENTRY_ENABLED: 'true' }, 'workers').enabled).toBe(false)
    expect(
      resolveMonitoringContext({ SENTRY_DSN: 'https://public@example.test/1' }, 'workers').enabled,
    ).toBe(false)
    expect(
      resolveMonitoringContext(
        { SENTRY_DSN: 'https://public@example.test/1', SENTRY_ENABLED: 'true' },
        'workers',
      ).enabled,
    ).toBe(true)
  })

  it('does not let the server flag enable a public runtime', () => {
    expect(
      resolveMonitoringContext(
        {
          NEXT_PUBLIC_SENTRY_DSN: 'https://public@example.test/1',
          SENTRY_ENABLED: 'true',
        },
        'web',
        true,
      ).enabled,
    ).toBe(false)
  })

  it('uses only explicitly public deployment metadata in a browser runtime', () => {
    expect(
      resolveMonitoringContext(
        {
          NEXT_PUBLIC_SENTRY_ENVIRONMENT: 'preview',
          NEXT_PUBLIC_SENTRY_RELEASE: 'public-sha',
          RAILWAY_ENVIRONMENT: 'production',
          SENTRY_RELEASE: 'server-sha',
        },
        'web-browser',
        true,
      ),
    ).toMatchObject({ environment: 'preview', release: 'public-sha' })
  })

  it('uses bounded deployment metadata and rejects arbitrary values', () => {
    expect(
      resolveMonitoringContext(
        {
          RAILWAY_ENVIRONMENT: 'staging',
          RAILWAY_GIT_COMMIT_SHA: 'abc123',
        },
        'dashboard',
      ),
    ).toMatchObject({ environment: 'staging', release: 'abc123', service: 'dashboard' })

    expect(
      resolveMonitoringContext(
        { RAILWAY_ENVIRONMENT: 'tenant one', SENTRY_RELEASE: 'secret value' },
        'dashboard',
      ),
    ).toMatchObject({ environment: 'unknown', release: 'unknown' })
  })
})

describe('sanitizeMonitoringEvent', () => {
  it('removes content and identity while preserving bounded error locations', () => {
    const serialized = JSON.stringify(
      sanitizeMonitoringEvent({
        breadcrumbs: [{ message: 'secret breadcrumb' }],
        contexts: { app: { prompt: 'secret prompt' } },
        exception: {
          values: [
            {
              type: 'ProviderError',
              value: 'provider echoed secret prompt',
              stacktrace: {
                frames: [
                  {
                    abs_path: 'C:/Users/private/path.ts',
                    context_line: 'const token = "secret"',
                    filename: 'apps/workers/dist/index.js',
                    function: 'runJob',
                    lineno: 42,
                    vars: { token: 'secret' },
                  },
                ],
              },
            },
          ],
        },
        extra: { authorization: 'Bearer secret' },
        fingerprint: ['worker/job-failed', 'unsafe value'],
        message: 'secret message',
        request: { cookies: { session: 'secret' }, url: '/venue/private' },
        tags: {
          action: 'workers.job.failed',
          release: 'abc123',
          tenantId: 'tenant-secret',
        },
        transaction: '/venues/private',
        user: { email: 'person@example.test', id: 'secret' },
      }),
    )

    expect(serialized).toContain(monitoringErrorMessage)
    expect(serialized).toContain('apps/workers/dist/index.js')
    expect(serialized).toContain('workers.job.failed')
    expect(serialized).not.toMatch(/secret|person@example|private|authorization|token/i)
  })

  it('drops untrusted stack filenames, exception types, tags and fingerprints', () => {
    const event = sanitizeMonitoringEvent({
      exception: {
        values: [
          {
            type: 'TenantSecretError',
            value: 'hidden',
            stacktrace: {
              frames: [
                { filename: '/venues/tenant-secret?token=value' },
                { filename: 'file:///private/tenant-secret.ts' },
                { filename: 'webpack-private/tenant-secret.ts' },
              ],
            },
          },
        ],
      },
      fingerprint: ['tenant-secret'],
      tags: { action: 'tenant secret', unknown: 'secret' },
    })

    expect(JSON.stringify(event)).not.toMatch(/tenant|secret|token|venues/i)
    expect(event.exception?.values?.[0]?.type).toBe('Error')
  })

  it('uses a positive allow-list for hostile SDK payload fields', () => {
    const serialized = JSON.stringify(
      sanitizeMonitoringEvent({
        event_id: '0123456789abcdef0123456789abcdef',
        level: 'error',
        logentry: { formatted: 'secret log entry' },
        modules: { 'secret-module': 'private' },
        sdk: { integrations: ['secret integration'] },
        spans: [{ data: { prompt: 'secret span' } }],
        threads: { values: [{ stacktrace: { frames: [{ vars: { token: 'secret' } }] } }] },
        timestamp: 1_700_000_000,
      }),
    )

    expect(serialized).toContain('0123456789abcdef0123456789abcdef')
    expect(serialized).not.toMatch(/logentry|modules|sdk|spans|threads|secret|private|token/i)
  })
})
