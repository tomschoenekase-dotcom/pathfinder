export const dynamic = 'force-dynamic'

import { createHash } from 'node:crypto'

import { Webhook } from 'svix'

import { env, logger } from '@pathfinder/config'
import { handleClerkEvent, isClerkWebhookReceiptConflictError } from '@pathfinder/db'
import { enqueueWelcomeEmail } from '@pathfinder/jobs'

import type { ClerkWebhookEvent } from '@pathfinder/db'

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024
const MAX_WEBHOOK_BODY_READ_MS = 5_000

class WebhookBodyError extends Error {
  constructor(readonly status: 400 | 408 | 413) {
    super(
      status === 413 ? 'payload-too-large' : status === 408 ? 'body-read-timeout' : 'invalid-body',
    )
    this.name = 'WebhookBodyError'
  }
}

async function readBoundedWebhookBody(req: Request): Promise<string> {
  const declaredLength = req.headers.get('content-length')
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) throw new WebhookBodyError(400)
    if (Number(declaredLength) > MAX_WEBHOOK_BODY_BYTES) throw new WebhookBodyError(413)
  }

  const reader = req.body?.getReader()
  if (!reader) return ''

  const chunks: Uint8Array[] = []
  let totalBytes = 0
  const deadline = AbortSignal.timeout(MAX_WEBHOOK_BODY_READ_MS)
  const signals = [req.signal, deadline]
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new WebhookBodyError(408))
    for (const signal of signals) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    let reading = true
    while (reading) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) {
        reading = false
        continue
      }
      totalBytes += value.byteLength
      if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
        void reader.cancel().catch(() => undefined)
        throw new WebhookBodyError(413)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof WebhookBodyError && error.status === 408) {
      void reader.cancel().catch(() => undefined)
    }
    if (error instanceof WebhookBodyError) throw error
    throw new WebhookBodyError(400)
  } finally {
    if (onAbort) {
      for (const signal of signals) signal.removeEventListener('abort', onAbort)
    }
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WebhookBodyError(400)
  }
}

export async function POST(req: Request): Promise<Response> {
  // Reject unsigned requests before reading their body. A caller that cannot
  // present the provider's signature headers gets no pre-auth body budget.
  const svixId = req.headers.get('svix-id')
  const svixTimestamp = req.headers.get('svix-timestamp')
  const svixSignature = req.headers.get('svix-signature')

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response('Unauthorized', { status: 401 })
  }

  const secret = env.CLERK_WEBHOOK_SECRET
  if (!secret) {
    logger.error({
      service: '@pathfinder/dashboard',
      action: 'clerk.webhook.missing_secret',
      error: 'CLERK_WEBHOOK_SECRET is not configured',
    })
    return new Response('Internal Server Error', { status: 500 })
  }

  // Svix needs the exact raw UTF-8 body. Bound both declared and streamed bytes
  // before signature verification so untrusted ingress cannot force an
  // unbounded allocation.
  let body: string
  try {
    body = await readBoundedWebhookBody(req)
  } catch (error) {
    const status = error instanceof WebhookBodyError ? error.status : 400
    const message =
      status === 413 ? 'Payload Too Large' : status === 408 ? 'Request Timeout' : 'Bad Request'
    return new Response(message, { status })
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

  // Process verified events. Dependency failures return 503 so Clerk can redeliver.
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
