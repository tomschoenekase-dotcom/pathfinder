import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'

import { db, writeAuditLogStrict, withTenantIsolationBypass } from '@pathfinder/db'

import { GmailApiError, type GmailCredentialLeaseProvider } from './gmail'
import { createGmailApiClient } from './gmail-http-client'

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const TOKEN_RESPONSE_MAX_BYTES = 1024 * 1024
const GOOGLE_REQUEST_TIMEOUT_MS = 30_000
const GOOGLE_WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/meetings.space.readonly',
] as const

type Fetch = typeof fetch

function boundedTimeout(value: number | undefined) {
  const timeoutMs = value ?? GOOGLE_REQUEST_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Google OAuth timeout must be an integer from 1 to 60000 milliseconds')
  }
  return timeoutMs
}

async function readTokenPayload(response: Response, signal: AbortSignal) {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > TOKEN_RESPONSE_MAX_BYTES)) {
    void response.body?.cancel().catch(() => undefined)
    return null
  }
  if (!response.body) return null

  const reader = response.body.getReader()
  const cancelOnAbort = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', cancelOnAbort, { once: true })
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let reading = true
  try {
    while (reading) {
      const { done, value } = await reader.read()
      if (done) {
        reading = false
        continue
      }
      totalBytes += value.byteLength
      if (totalBytes > TOKEN_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', cancelOnAbort)
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function encryptionKey(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('INTEGRATION_ENCRYPTION_KEY must be 32 base64 bytes')
  return key
}

function encrypt(secret: string, key: Buffer, aad: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const encryptedSecret = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return { encryptedSecret, initializationVector: iv, authenticationTag: cipher.getAuthTag() }
}

function decrypt(
  value: {
    encryptedSecret: Uint8Array
    initializationVector: Uint8Array
    authenticationTag: Uint8Array
  },
  key: Buffer,
  aad: string,
) {
  const decipher = createDecipheriv('aes-256-gcm', key, value.initializationVector)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(value.authenticationTag))
  return Buffer.concat([
    decipher.update(Buffer.from(value.encryptedSecret)),
    decipher.final(),
  ]).toString('utf8')
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function tokenRequest(input: {
  transport: Fetch
  body: URLSearchParams
  mayUseRefreshToken: boolean
  timeoutMs: number
}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    let response: Response
    try {
      response = await input.transport(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: input.body,
        signal: controller.signal,
      })
    } catch {
      throw new GmailApiError(
        'TRANSIENT',
        controller.signal.aborted
          ? 'Google OAuth token exchange timed out'
          : 'Google OAuth transport failed',
      )
    }
    const payload = await readTokenPayload(response, controller.signal)
    if (controller.signal.aborted) {
      throw new GmailApiError('TRANSIENT', 'Google OAuth token exchange timed out')
    }
    if (!response.ok || !payload) {
      const invalidGrant = payload?.error === 'invalid_grant'
      const transient = response.status === 408 || response.status === 429 || response.status >= 500
      throw new GmailApiError(
        invalidGrant && input.mayUseRefreshToken
          ? 'AUTHENTICATION'
          : transient
            ? 'TRANSIENT'
            : 'PERMANENT',
        'Google OAuth token exchange failed',
      )
    }
    const accessToken = payload.access_token
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new GmailApiError('PERMANENT', 'Google OAuth response omitted an access token')
    }
    return {
      accessToken,
      refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export type GmailOAuthConfiguration = Readonly<{
  clientId: string
  clientSecret: string
  redirectUri: string
  integrationEncryptionKey: string
}>

export function createGmailOAuthRuntime(input: {
  configuration: GmailOAuthConfiguration
  fetch?: Fetch
  now?: () => Date
  requestTimeoutMs?: number
}) {
  const { configuration } = input
  const key = encryptionKey(configuration.integrationEncryptionKey)
  const transport = input.fetch ?? fetch
  const now = input.now ?? (() => new Date())
  const timeoutMs = boundedTimeout(input.requestTimeoutMs)
  const gmail = createGmailApiClient({ fetch: transport, requestTimeoutMs: timeoutMs })

  const credentials: GmailCredentialLeaseProvider = {
    async lease(credentialRef) {
      const credential = await withTenantIsolationBypass(() =>
        db.encryptedIntegrationCredential.findFirst({
          where: { id: credentialRef, provider: 'GMAIL', revokedAt: null },
        }),
      )
      if (!credential) throw new GmailApiError('AUTHENTICATION', 'Gmail credential is unavailable')
      return {
        async withAccessToken<T>(callback: (accessToken: string) => Promise<T>) {
          const refreshToken = decrypt(credential, key, `gmail-refresh:${credential.id}`)
          const token = await tokenRequest({
            transport,
            timeoutMs,
            mayUseRefreshToken: true,
            body: new URLSearchParams({
              client_id: configuration.clientId,
              client_secret: configuration.clientSecret,
              refresh_token: refreshToken,
              grant_type: 'refresh_token',
            }),
          })
          return callback(token.accessToken)
        },
      }
    },
  }

  return {
    credentials,
    async begin(requestedBy: string) {
      const state = randomBytes(32).toString('base64url')
      const verifier = randomBytes(48).toString('base64url')
      const id = randomUUID()
      const sealed = encrypt(verifier, key, `gmail-oauth-attempt:${id}`)
      await withTenantIsolationBypass(() =>
        db.gmailOAuthAttempt.create({
          data: {
            id,
            stateHash: sha256(state),
            encryptedCodeVerifier: sealed.encryptedSecret,
            initializationVector: sealed.initializationVector,
            authenticationTag: sealed.authenticationTag,
            redirectUri: configuration.redirectUri,
            requestedBy,
            expiresAt: new Date(now().getTime() + 10 * 60_000),
          },
        }),
      )
      const authorization = new URL(AUTHORIZATION_ENDPOINT)
      authorization.search = new URLSearchParams({
        client_id: configuration.clientId,
        redirect_uri: configuration.redirectUri,
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        scope: GOOGLE_WORKSPACE_SCOPES.join(' '),
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString()
      return authorization.toString()
    },
    async complete(args: { state: string; code: string; requestedBy: string }) {
      const stateHash = sha256(args.state)
      const consumedAt = now()
      const attempt = await withTenantIsolationBypass(async () => {
        const claimed = await db.gmailOAuthAttempt.updateMany({
          where: {
            stateHash,
            requestedBy: args.requestedBy,
            consumedAt: null,
            expiresAt: { gt: consumedAt },
          },
          data: { consumedAt },
        })
        if (claimed.count !== 1) return null
        return db.gmailOAuthAttempt.findUnique({ where: { stateHash } })
      })
      if (!attempt || attempt.redirectUri !== configuration.redirectUri) {
        throw new GmailApiError('PERMANENT', 'Google OAuth state is invalid or expired')
      }
      const verifier = decrypt(
        {
          encryptedSecret: attempt.encryptedCodeVerifier,
          initializationVector: attempt.initializationVector,
          authenticationTag: attempt.authenticationTag,
        },
        key,
        `gmail-oauth-attempt:${attempt.id}`,
      )
      const token = await tokenRequest({
        transport,
        timeoutMs,
        mayUseRefreshToken: false,
        body: new URLSearchParams({
          client_id: configuration.clientId,
          client_secret: configuration.clientSecret,
          code: args.code,
          code_verifier: verifier,
          redirect_uri: configuration.redirectUri,
          grant_type: 'authorization_code',
        }),
      })
      if (!token.refreshToken) {
        throw new GmailApiError('PERMANENT', 'Google OAuth did not return offline access')
      }
      const profile = await gmail.getProfile({
        accessToken: token.accessToken,
        mailboxAddress: 'me',
      })
      const credentialId = randomUUID()
      const sealed = encrypt(token.refreshToken, key, `gmail-refresh:${credentialId}`)
      return withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          const existing = await tx.correspondenceProviderAccount.findUnique({
            where: {
              provider_mailboxAddress: {
                provider: 'GMAIL',
                mailboxAddress: profile.emailAddress.toLowerCase(),
              },
            },
          })
          await tx.encryptedIntegrationCredential.create({
            data: {
              id: credentialId,
              provider: 'GMAIL',
              subject: profile.emailAddress.toLowerCase(),
              ...sealed,
              createdBy: args.requestedBy,
            },
          })
          if (existing?.credentialReferenceId) {
            await tx.encryptedIntegrationCredential.updateMany({
              where: { id: existing.credentialReferenceId, revokedAt: null },
              data: { revokedAt: consumedAt },
            })
          }
          const account = await tx.correspondenceProviderAccount.upsert({
            where: {
              provider_mailboxAddress: {
                provider: 'GMAIL',
                mailboxAddress: profile.emailAddress.toLowerCase(),
              },
            },
            create: {
              provider: 'GMAIL',
              externalAccountId: profile.emailAddress.toLowerCase(),
              mailboxAddress: profile.emailAddress.toLowerCase(),
              capabilities: [
                'SEND',
                'RECEIVE',
                'WATCH',
                'RECONCILE',
                'CALENDAR_READ',
                'MEET_TRANSCRIPTS',
              ],
              connectionStatus: 'CONNECTED',
              credentialReferenceId: credentialId,
              syncCursor: profile.historyId,
              deliveryEnabled: false,
              createdBy: args.requestedBy,
              updatedBy: args.requestedBy,
            },
            update: {
              connectionStatus: 'CONNECTED',
              credentialReferenceId: credentialId,
              syncCursor: profile.historyId,
              healthErrorCode: null,
              healthErrorSummary: null,
              deliveryEnabled: false,
              updatedBy: args.requestedBy,
            },
          })
          await writeAuditLogStrict(
            {
              actorId: args.requestedBy,
              actorRole: 'PLATFORM_ADMIN',
              action: existing ? 'prospect.gmail.reconnected' : 'prospect.gmail.connected',
              targetType: 'CorrespondenceProviderAccount',
              targetId: account.id,
              afterState: {
                provider: 'GMAIL',
                mailboxAddress: account.mailboxAddress,
                deliveryEnabled: false,
              },
            },
            tx,
          )
          return {
            id: account.id,
            mailboxAddress: account.mailboxAddress,
            connectionStatus: account.connectionStatus,
            deliveryEnabled: account.deliveryEnabled,
          }
        }),
      )
    },
  }
}
