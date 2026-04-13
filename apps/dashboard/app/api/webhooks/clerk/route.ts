import { Webhook } from 'svix'

import { env, logger } from '@pathfinder/config'
import { handleClerkEvent } from '@pathfinder/db'

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

  // 4. Process event — return 200 even on DB errors to prevent Clerk retry loops
  try {
    await handleClerkEvent(event)
  } catch (err) {
    logger.error({
      service: '@pathfinder/dashboard',
      action: 'clerk.webhook.process_failed',
      error: err instanceof Error ? err.message : 'Unknown error',
    })
  }

  return new Response('OK', { status: 200 })
}
