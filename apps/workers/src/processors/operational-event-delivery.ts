import { Resend } from 'resend'

import { env, logger } from '@pathfinder/config'
import {
  materializeOperationalEventDeliveries,
  operationalEventDestinationKey,
  readNextOperationalEventDelivery,
  recordOperationalEventDeliveryAttempt,
  withTenantIsolationBypass,
  type OperationalEventRoutingPolicyType,
} from '@pathfinder/db'

export type OperationalEventDeliveryMessage = {
  subject: string
  text: string
  recordUrl: string
}

export interface OperationalEventDeliveryAdapter {
  channel: 'EMAIL' | 'SLACK' | 'WEBHOOK'
  provider: string
  send(message: OperationalEventDeliveryMessage): Promise<{ providerRef?: string }>
}

function configuredRoute(): OperationalEventRoutingPolicyType | null {
  if (env.OPERATIONAL_ALERT_DEV_SINK_ENABLED && env.RAILWAY_ENVIRONMENT !== 'production') {
    return {
      channel: 'WEBHOOK',
      destination: 'development-log-sink',
      minimumSeverity: env.OPERATIONAL_ALERT_MIN_SEVERITY ?? 'ERROR',
    }
  }
  if (
    env.OPERATIONAL_ALERT_DELIVERY_ENABLED &&
    env.OPERATIONAL_ALERT_EMAIL_TO &&
    env.RESEND_API_KEY
  ) {
    return {
      channel: 'EMAIL',
      destination: env.OPERATIONAL_ALERT_EMAIL_TO,
      minimumSeverity: env.OPERATIONAL_ALERT_MIN_SEVERITY ?? 'ERROR',
    }
  }
  return null
}

function defaultAdapter(
  policy: OperationalEventRoutingPolicyType,
): OperationalEventDeliveryAdapter {
  if (policy.channel === 'WEBHOOK' && policy.destination === 'development-log-sink') {
    return {
      channel: 'WEBHOOK',
      provider: 'development-log-sink',
      async send(message) {
        logger.info({
          action: 'workers.operational-event-delivery.dev-sink',
          subject: message.subject,
          recordUrl: message.recordUrl,
        })
        return {}
      },
    }
  }
  if (policy.channel !== 'EMAIL' || !env.RESEND_API_KEY) {
    throw new Error('No authorized operational-event delivery adapter is configured')
  }
  const resend = new Resend(env.RESEND_API_KEY)
  return {
    channel: 'EMAIL',
    provider: 'resend',
    async send(message) {
      const response = await resend.emails.send({
        from: `Torchiko Operations <${env.RESEND_FROM_EMAIL ?? 'noreply@torchiko.com'}>`,
        to: policy.destination,
        subject: message.subject,
        text: `${message.text}\n\nOpen the Torchiko operations record: ${message.recordUrl}`,
      })
      if (response.error) throw new Error('Operational alert provider rejected the request')
      return response.data?.id ? { providerRef: response.data.id } : {}
    },
  }
}

function retryAt(attemptNumber: number, now: Date): Date {
  const delayMs = Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attemptNumber - 1))
  return new Date(now.getTime() + delayMs)
}

export async function processOperationalEventDeliveries(
  dependencies: {
    policy?: OperationalEventRoutingPolicyType | null
    adapter?: OperationalEventDeliveryAdapter
    now?: Date
  } = {},
) {
  const policy = dependencies.policy === undefined ? configuredRoute() : dependencies.policy
  if (!policy) return { status: 'disabled' as const, processed: 0 }
  const adapter = dependencies.adapter ?? defaultAdapter(policy)
  if (adapter.channel !== policy.channel) throw new Error('Delivery adapter channel mismatch')
  const destinationKey = operationalEventDestinationKey(policy)
  const now = dependencies.now ?? new Date()
  await withTenantIsolationBypass(() => materializeOperationalEventDeliveries(policy))
  let processed = 0
  for (; processed < 25; processed += 1) {
    const delivery = await withTenantIsolationBypass(() =>
      readNextOperationalEventDelivery({ channel: policy.channel, destinationKey, now }),
    )
    if (!delivery) break
    const attemptNumber = delivery.attemptCount + 1
    const recordUrl = `${env.DASHBOARD_URL ?? 'http://localhost:3101'}/admin/clients/${encodeURIComponent(delivery.tenantId)}${delivery.event.venueId ? `/venues/${encodeURIComponent(delivery.event.venueId)}` : ''}/operations?event=${encodeURIComponent(delivery.eventId)}`
    try {
      const result = await adapter.send({
        subject: `[${delivery.event.severity}] ${delivery.event.title}`,
        text: `${delivery.event.summary}${delivery.event.recommendedAction ? `\n\nRecommended action: ${delivery.event.recommendedAction}` : ''}`,
        recordUrl,
      })
      await withTenantIsolationBypass(() =>
        recordOperationalEventDeliveryAttempt({
          deliveryId: delivery.id,
          tenantId: delivery.tenantId,
          attemptNumber,
          status: 'SENT',
          provider: adapter.provider,
          ...(result.providerRef ? { providerRef: result.providerRef } : {}),
        }),
      )
    } catch {
      await withTenantIsolationBypass(() =>
        recordOperationalEventDeliveryAttempt({
          deliveryId: delivery.id,
          tenantId: delivery.tenantId,
          attemptNumber,
          status: attemptNumber >= 6 ? 'SUPPRESSED' : 'FAILED',
          provider: adapter.provider,
          errorCode: attemptNumber >= 6 ? 'retry-exhausted' : 'provider-failure',
          ...(attemptNumber < 6 ? { nextAttemptAt: retryAt(attemptNumber, now) } : {}),
        }),
      )
    }
  }
  return { status: 'enabled' as const, processed }
}
