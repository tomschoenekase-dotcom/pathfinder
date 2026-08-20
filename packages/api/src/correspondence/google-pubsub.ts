type GoogleJwtPayload = Readonly<Record<string, unknown>> & {
  sub?: string
  email?: string
  email_verified?: boolean
}

export type VerifiedGooglePubSubIdentity = Readonly<{
  subject: string
  email: string
}>

export async function verifyGooglePubSubPush(input: {
  authorization: string | null
  expectedAudience: string
  expectedServiceAccount: string
  verify?: (token: string, audience: string) => Promise<GoogleJwtPayload>
}): Promise<VerifiedGooglePubSubIdentity> {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(input.authorization ?? '')
  if (!match?.[1]) throw new Error('PUBSUB_AUTHENTICATION_REQUIRED')
  const token = match[1]
  const payload = input.verify
    ? await input.verify(token, input.expectedAudience)
    : await (async () => {
        // jose is ESM-only; the dynamic boundary keeps this workspace package consumable by
        // both the Next.js ESM graph and the workers' CommonJS build without weakening JWT checks.
        const { createRemoteJWKSet, jwtVerify } = await import('jose')
        const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
        return (
          await jwtVerify(token, googleJwks, {
            audience: input.expectedAudience,
            issuer: ['https://accounts.google.com', 'accounts.google.com'],
            algorithms: ['RS256'],
          })
        ).payload
      })()
  if (
    typeof payload.sub !== 'string' ||
    payload.email !== input.expectedServiceAccount ||
    payload.email_verified !== true
  ) {
    throw new Error('PUBSUB_IDENTITY_REJECTED')
  }
  return { subject: payload.sub, email: input.expectedServiceAccount }
}

export function parseGmailPushEnvelope(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PUBSUB_ENVELOPE_INVALID')
  }
  const envelope = value as Record<string, unknown>
  if (
    !envelope.message ||
    typeof envelope.message !== 'object' ||
    Array.isArray(envelope.message)
  ) {
    throw new Error('PUBSUB_MESSAGE_INVALID')
  }
  const message = envelope.message as Record<string, unknown>
  if (typeof message.messageId !== 'string' || typeof message.data !== 'string') {
    throw new Error('PUBSUB_MESSAGE_INVALID')
  }
  let notification: unknown
  try {
    notification = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'))
  } catch {
    throw new Error('PUBSUB_DATA_INVALID')
  }
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
    throw new Error('PUBSUB_DATA_INVALID')
  }
  const data = notification as Record<string, unknown>
  if (
    typeof data.emailAddress !== 'string' ||
    data.emailAddress.length > 320 ||
    typeof data.historyId !== 'string' ||
    !/^\d{1,40}$/u.test(data.historyId)
  ) {
    throw new Error('PUBSUB_DATA_INVALID')
  }
  return {
    messageId: message.messageId.slice(0, 191),
    emailAddress: data.emailAddress.toLowerCase(),
    historyId: data.historyId,
    subscription:
      typeof envelope.subscription === 'string' ? envelope.subscription.slice(0, 500) : null,
  }
}
