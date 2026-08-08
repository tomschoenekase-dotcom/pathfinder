export const dynamic = 'force-dynamic'

import { createHash } from 'node:crypto'

import { Webhook } from 'svix'

import { env, logger } from '@pathfinder/config'
import { handleClerkEvent, isClerkWebhookReceiptConflictError } from '@pathfinder/db'
import { enqueueWelcomeEmail } from '@pathfinder/jobs'

import type { ClerkWebhookEvent } from '@pathfinder/db'

export async function POST(req: Request): Promise<Response> {
  // 1. Read raw body as text — Svix needs the raw bytes for signature verification
  const body = await req.text()

  // 2. Extract Svix headers
  const svixId = req.headers.get('svix-id')
  const svixTimestamp = req.headers.get('svix-timestamp')
  const svixSignature = req.headers.get('svix-signature')

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response('Unauthorized', { status: 401 })
  }

  // 3. Verify signature
  const secret = env.CLERK_WEBHOOK_SECRET
  if (!secret) {
    logger.error({
      service: '@pathfinder/dashboard',
      action: 'clerk.webhook.missing_secret',
      error: 'CLERK_WEBHOOK_SECRET is not configured',
    })
    return new Response('Internal Server Error', { status: 500 })
  }

  const wh = new Webhook(secret)
  let event: ClerkWebhookEvent

  try {
    event = wh.verify(body, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as ClerkWebhookEvent
  } catch {
    return new Response('Unauthorized', { status: 401 })
  }

  // 4. Process verified events. Dependency failures return 503 so Clerk can redeliver.
  try {
    const processing = await handleClerkEvent(event, {
      providerEventId: svixId,
      payloadHash: createHash('sha256').update(body, 'utf8').digest('hex'),
    })

    if (
      processing.welcomeEmailDeliveryId &&
      event.type === 'organizationMembership.created' &&
      event.data.role === 'org:admin'
    ) {
      const email = event.data.public_user_data.email_addresses?.[0]?.email_address

      if (email) {
        const recipientName =
          [event.data.public_user_data.first_name, event.data.public_user_data.last_name]
            .filter(Boolean)
            .join(' ') || null

        await enqueueWelcomeEmail(
          {
            tenantId: event.data.organization.id,
            to: email,
            recipientName,
            orgName: event.data.organization.name ?? '',
          },
          processing.welcomeEmailDeliveryId,
        )
      }
    }
  } catch (err) {
    if (isClerkWebhookReceiptConflictError(err)) {
      logger.error({
        service: '@pathfinder/dashboard',
        action: 'clerk.webhook.identity_conflict',
        eventType: event.type,
        error: 'Verified Clerk webhook identity conflicts with an existing receipt',
      })
      // The verified mismatch is contained and cannot succeed on retry. Clerk/Svix retries every
      // non-2xx response, so acknowledge it after emitting the sanitized operator signal.
      return new Response('Conflict acknowledged', { status: 200 })
    }

    logger.error({
      service: '@pathfinder/dashboard',
      action: 'clerk.webhook.process_failed',
      eventType: event.type,
      error: 'Verified Clerk webhook processing failed',
      errorType: err instanceof Error ? err.name : 'UnknownError',
    })
    return new Response('Service Unavailable', { status: 503 })
  }

  return new Response('OK', { status: 200 })
}
