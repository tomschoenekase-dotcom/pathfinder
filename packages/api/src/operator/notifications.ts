import { resolveVerifiedMemberEmail } from '@pathfinder/auth'
import { logger } from '@pathfinder/config'
import {
  markClientNotificationEnqueueFailed,
  type ClientNotificationIntentRef,
} from '@pathfinder/db'
import { enqueueClientNotificationEmail } from '@pathfinder/jobs'

import type { OperatorDatabase } from './audit'
import { isClientNotificationEmailEnabled } from './kinds/release-gate'

/**
 * The edges of a client notification: the identity provider (who may be emailed and at what
 * verified address), the queue, and the deployment switch. Each is a seam so the proof runs
 * without any of them; production always uses the real ones.
 */
export type NotificationDeps = {
  /** The one address the identity provider verified for this member, or null. Never guessed. */
  resolveVerifiedEmail: (userId: string) => Promise<string | null>
  enqueueEmail: typeof enqueueClientNotificationEmail
  emailEnabled: () => boolean
}

const realDeps: NotificationDeps = {
  resolveVerifiedEmail: async (userId) =>
    (await resolveVerifiedMemberEmail(userId))?.emailAddress ?? null,
  enqueueEmail: (payload) => enqueueClientNotificationEmail(payload),
  emailEnabled: () => isClientNotificationEmailEnabled(),
}
let deps: NotificationDeps = realDeps

/** Test seam only. */
export function setNotificationDepsForTests(next: Partial<NotificationDeps> | null) {
  deps = next === null ? realDeps : { ...realDeps, ...next }
}

/** Read before the database transaction: the identity call must not run inside it. */
export async function prepareNotificationEmail(recipientUserId: string) {
  return {
    recipientEmail: await deps.resolveVerifiedEmail(recipientUserId),
    emailEnabled: deps.emailEnabled(),
  }
}

export type NotificationEmailLabel =
  | 'not_requested'
  | 'email_queued'
  | 'email_sent'
  | 'email_failed'
  | 'email_unknown'

export const emailLabel = (
  status: ClientNotificationIntentRef['emailStatus'],
): NotificationEmailLabel =>
  status === null
    ? 'not_requested'
    : status === 'SENT'
      ? 'email_sent'
      : status === 'FAILED'
        ? 'email_failed'
        : status === 'UNKNOWN'
          ? 'email_unknown'
          : 'email_queued'

/**
 * Hands one queued email to the worker after the intent has committed. The job ID is derived from
 * the intent and generation, so doing this twice (an apply that is replayed, or reconciled) is one
 * job. A queue that cannot be reached closes the email as failed, retryable, rather than leaving
 * it queued forever; the portal post is unaffected.
 */
export async function dispatchNotificationEmail(
  database: OperatorDatabase,
  intent: Pick<ClientNotificationIntentRef, 'id' | 'tenantId' | 'emailStatus' | 'emailGeneration'>,
): Promise<NotificationEmailLabel> {
  if (intent.emailStatus !== 'QUEUED') return emailLabel(intent.emailStatus)
  try {
    await deps.enqueueEmail({
      tenantId: intent.tenantId,
      intentId: intent.id,
      generation: intent.emailGeneration,
    })
    return 'email_queued'
  } catch (error) {
    logger.error({
      action: 'operator.notification.enqueue-failed',
      error: error instanceof Error ? error.name : 'unknown',
      tenantId: intent.tenantId,
      intentId: intent.id,
    })
    await markClientNotificationEnqueueFailed(
      { tenantId: intent.tenantId, intentId: intent.id, generation: intent.emailGeneration },
      database as never,
    )
    return 'email_failed'
  }
}

/** Re-offers every still-queued email of one request, for an apply that is being reconciled. */
export async function dispatchQueuedForRequest(
  database: OperatorDatabase,
  scope: { tenantId: string; supportRequestId: string },
): Promise<NotificationEmailLabel | null> {
  const intents = await database.clientNotificationIntent.findMany({
    where: { tenantId: scope.tenantId, supportRequestId: scope.supportRequestId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 5,
    select: { id: true, tenantId: true, emailStatus: true, emailGeneration: true },
  })
  let last: NotificationEmailLabel | null = null
  for (const intent of intents) last = await dispatchNotificationEmail(database, intent)
  return last
}
