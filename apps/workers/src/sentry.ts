import * as Sentry from '@sentry/node'

import { setErrorMonitor, type LogFields } from '@pathfinder/config/logger'
import {
  monitoringErrorMessage,
  resolveMonitoringContext,
  sanitizeMonitoringEvent,
} from '@pathfinder/config/monitoring'

const context = resolveMonitoringContext(process.env, 'workers')

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
  includeLocalVariables: false,
  initialScope: { tags: { service: context.service } },
  maxBreadcrumbs: 0,
  profilesSampleRate: 0,
  release: context.release,
  sendClientReports: false,
  sendDefaultPii: false,
  tracesSampleRate: 0,
})

if (context.enabled) {
  setErrorMonitor((fields: Readonly<LogFields>) => {
    Sentry.withScope((scope) => {
      scope.setTag('action', fields.action)
      scope.setFingerprint(['handled-error', fields.action])
      Sentry.captureException(new Error(monitoringErrorMessage))
    })
  })
}
