export const dynamic = 'force-dynamic'

import {
  STRIPE_API_VERSION,
  StripeBillingProvider,
  applyVerifiedStripeEvent,
  createStripeClient,
  parseBillingEnvironment,
} from '@pathfinder/billing'
import { logger } from '@pathfinder/config/logger'

const MAX_BODY_BYTES = 256 * 1024
const MAX_BODY_READ_MS = 5_000

class BodyError extends Error {
  constructor(readonly status: 400 | 408 | 413) {
    super('Invalid webhook body')
  }
}

async function readBoundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) throw new BodyError(400)
    if (Number(declaredLength) > MAX_BODY_BYTES) throw new BodyError(413)
  }
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let byteCount = 0
  const deadline = AbortSignal.timeout(MAX_BODY_READ_MS)
  const signals = [request.signal, deadline]
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new BodyError(408))
    for (const signal of signals) {
      if (signal.aborted) return onAbort()
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
      byteCount += value.byteLength
      if (byteCount > MAX_BODY_BYTES) {
        void reader.cancel()
        throw new BodyError(413)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof BodyError) throw error
    throw new BodyError(400)
  } finally {
    if (onAbort) for (const signal of signals) signal.removeEventListener('abort', onAbort)
  }
  const bytes = new Uint8Array(byteCount)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new BodyError(400)
  }
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.STRIPE_WEBHOOK_PROCESSING_ENABLED !== 'true') {
    return new Response('Not Found', { status: 404 })
  }
  const signature = request.headers.get('stripe-signature')
  if (!signature) return new Response('Unauthorized', { status: 401 })

  let environment: ReturnType<typeof parseBillingEnvironment>
  try {
    environment = parseBillingEnvironment()
  } catch {
    logger.error({
      service: '@pathfinder/dashboard',
      action: 'stripe.webhook.invalid_configuration',
      error: 'Stripe webhook configuration is invalid',
    })
    return new Response('Service Unavailable', { status: 503 })
  }
  if (!environment.STRIPE_WEBHOOK_SECRET || !environment.STRIPE_SECRET_KEY) {
    logger.error({
      service: '@pathfinder/dashboard',
      action: 'stripe.webhook.missing_secret',
      error: 'Stripe webhook secret configuration is missing',
    })
    return new Response('Service Unavailable', { status: 503 })
  }

  let rawBody: string
  try {
    rawBody = await readBoundedBody(request)
  } catch (error) {
    const status = error instanceof BodyError ? error.status : 400
    return new Response(
      status === 413 ? 'Payload Too Large' : status === 408 ? 'Request Timeout' : 'Bad Request',
      { status },
    )
  }

  const provider = new StripeBillingProvider(createStripeClient(environment))
  let event
  try {
    event = provider.constructWebhookEvent(rawBody, signature, environment.STRIPE_WEBHOOK_SECRET)
  } catch {
    return new Response('Unauthorized', { status: 401 })
  }
  if (event.api_version !== STRIPE_API_VERSION) {
    logger.error({
      service: '@pathfinder/dashboard',
      action: 'stripe.webhook.api_version_mismatch',
      eventId: event.id,
      expectedApiVersion: STRIPE_API_VERSION,
      receivedApiVersion: event.api_version ?? 'none',
      error: 'Stripe webhook API version mismatch',
    })
    return new Response('Unsupported Stripe API version', { status: 400 })
  }
  try {
    await applyVerifiedStripeEvent({ event, rawPayload: rawBody, environment, provider })
  } catch (error) {
    logger.error({
      service: '@pathfinder/dashboard',
      action: 'stripe.webhook.processing_failed',
      eventId: event.id,
      eventType: event.type,
      errorType: error instanceof Error ? error.name : 'UnknownError',
      error: 'Verified Stripe webhook processing failed',
    })
    return new Response('Service Unavailable', { status: 503 })
  }
  return new Response('OK', { status: 200 })
}
