import * as Sentry from '@sentry/nextjs'
import { resolveMonitoringContext, sanitizeMonitoringEvent } from '@pathfinder/config/monitoring'

const context = resolveMonitoringContext(
  {
    NODE_ENV: process.env.NODE_ENV,
    RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
    RAILWAY_GIT_COMMIT_SHA: process.env.RAILWAY_GIT_COMMIT_SHA,
    SENTRY_DSN: process.env.SENTRY_DSN,
    SENTRY_ENABLED: process.env.SENTRY_ENABLED,
    SENTRY_RELEASE: process.env.SENTRY_RELEASE,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  },
  'dashboard-edge',
)

Sentry.init({
  beforeBreadcrumb: () => null,
  beforeSend: (event) => sanitizeMonitoringEvent(event),
  beforeSendTransaction: () => null,
  debug: false,
  dsn: context.enabled ? process.env.SENTRY_DSN : undefined,
  enableLogs: false,
  enableMetrics: false,
  enabled: context.enabled,
  environment: context.environment,
  initialScope: { tags: { service: context.service } },
  maxBreadcrumbs: 0,
  release: context.release,
  sendClientReports: false,
  sendDefaultPii: false,
  tracesSampleRate: 0,
})
