import * as Sentry from '@sentry/nextjs'
import { resolveMonitoringContext, sanitizeMonitoringEvent } from '@pathfinder/config/monitoring'

const context = resolveMonitoringContext(
  {
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_ENABLED: process.env.NEXT_PUBLIC_SENTRY_ENABLED,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    NEXT_PUBLIC_SENTRY_RELEASE: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    NODE_ENV: process.env.NODE_ENV,
  },
  'web-browser',
  true,
)

Sentry.init({
  beforeBreadcrumb: () => null,
  beforeSend: (event) => sanitizeMonitoringEvent(event),
  beforeSendTransaction: () => null,
  debug: false,
  dsn: context.enabled ? process.env.NEXT_PUBLIC_SENTRY_DSN : undefined,
  enableLogs: false,
  enableMetrics: false,
  enabled: context.enabled,
  environment: context.environment,
  initialScope: { tags: { service: context.service } },
  maxBreadcrumbs: 0,
  release: context.release,
  replaysOnErrorSampleRate: 0,
  replaysSessionSampleRate: 0,
  sendClientReports: false,
  sendDefaultPii: false,
  tracesSampleRate: 0,
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
