import { createHash } from 'node:crypto'

import type { CorrespondenceProvider, FrozenCorrespondence } from '@pathfinder/api/correspondence'
import {
  CorrespondenceProviderError,
  createGmailApiClient,
  createGmailCorrespondenceProvider,
  createGmailOAuthRuntime,
} from '@pathfinder/api/correspondence'
import {
  claimProspectSendOutboxAction,
  recordProspectSendFailureAction,
  recordProspectSendSuccessAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import type { SendProspectOutreachJobPayload } from '@pathfinder/jobs'

let testProvider: CorrespondenceProvider | null | undefined
let gmailProvider: CorrespondenceProvider | null | undefined

function configuredGmailProvider(): CorrespondenceProvider | null {
  if (gmailProvider !== undefined) return gmailProvider
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const redirectUri = process.env.GMAIL_OAUTH_REDIRECT_URI
  const integrationEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY
  if (!clientId || !clientSecret || !redirectUri || !integrationEncryptionKey) {
    gmailProvider = null
    return null
  }
  const oauth = createGmailOAuthRuntime({
    configuration: { clientId, clientSecret, redirectUri, integrationEncryptionKey },
  })
  gmailProvider = createGmailCorrespondenceProvider({
    credentials: oauth.credentials,
    client: createGmailApiClient(),
  })
  return gmailProvider
}

function providerForRuntime(key: 'GMAIL' | 'FAKE'): CorrespondenceProvider {
  if (testProvider?.key === key) return testProvider
  if (key === 'GMAIL') {
    const configured = configuredGmailProvider()
    if (configured) return configured
  }
  throw new CorrespondenceProviderError(
    'NOT_CONFIGURED',
    `${key} correspondence runtime is not mounted in this worker`,
  )
}

export function isProspectRecipientAllowed(recipient: string): boolean {
  if (process.env.PROSPECT_OUTREACH_RECIPIENT_MODE === 'production') return true
  const allowlist = new Set(
    (process.env.PROSPECT_OUTREACH_INTERNAL_ALLOWLIST ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  )
  return allowlist.has(recipient.trim().toLowerCase())
}

function providerFailure(error: unknown): {
  code: string
  retryable: boolean
  acceptanceAmbiguous: boolean
  retryAt?: Date
  message: string
} {
  if (error instanceof CorrespondenceProviderError) {
    return {
      code: error.code,
      retryable: ['RATE_LIMITED', 'TRANSIENT'].includes(error.code),
      acceptanceAmbiguous: error.code === 'AMBIGUOUS_SEND',
      ...(error.retryAfterMs
        ? { retryAt: new Date(Date.now() + Math.min(error.retryAfterMs, 86_400_000)) }
        : {}),
      message: error.message,
    }
  }
  return {
    code: 'UNCLASSIFIED_PROVIDER_FAILURE',
    retryable: false,
    acceptanceAmbiguous: true,
    message: error instanceof Error ? error.message : 'Unknown provider failure',
  }
}

export async function processSendProspectOutreachJob(
  payload: SendProspectOutreachJobPayload,
): Promise<void> {
  if (process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED !== 'true') {
    throw new Error('Prospect outreach delivery is disabled')
  }
  const workerId = `prospect-worker:${process.pid}`
  await withTenantIsolationBypass(async () => {
    const claimed = await claimProspectSendOutboxAction({
      outboxId: payload.outboxId,
      workerId,
    })
    if (!claimed) return
    if (!isProspectRecipientAllowed(claimed.recipient)) {
      await recordProspectSendFailureAction({
        outboxId: claimed.outboxId,
        workerId,
        code: 'INTERNAL_RECIPIENT_ALLOWLIST_BLOCKED',
        message: 'Recipient is outside the server-authoritative internal smoke-test allowlist',
        retryable: false,
        acceptanceAmbiguous: false,
      })
      return
    }
    const frozen: FrozenCorrespondence = {
      operationId: claimed.operationId,
      providerIdempotencyKey: claimed.idempotencyKey,
      mailbox: {
        provider: claimed.provider,
        providerAccountId: claimed.providerAccountId,
        mailboxId: claimed.externalAccountId,
        mailboxAddress: claimed.mailboxAddress,
        credentialRef: claimed.credentialReferenceId,
      },
      recipient: { email: claimed.recipient },
      from: { email: claimed.mailboxAddress },
      subject: claimed.subject,
      textBody: claimed.textBody,
      // Reviewed HTML sanitization is not mounted. Prospect delivery is text-only in this release.
      rfcMessageId: `<torchiko.${claimed.operationId}@torchiko.com>`,
      references: [],
    }
    try {
      const correspondence = providerForRuntime(claimed.provider)
      const result = await correspondence.sendOne(frozen)
      await recordProspectSendSuccessAction({
        outboxId: claimed.outboxId,
        workerId,
        providerMessageId: result.message.externalId,
        providerThreadId: result.thread.externalId,
        internetMessageId: result.rfcMessageId,
        acceptedAt: result.acceptedAt,
      })
    } catch (error) {
      const failure = providerFailure(error)
      await recordProspectSendFailureAction({
        outboxId: claimed.outboxId,
        workerId,
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        acceptanceAmbiguous: failure.acceptanceAmbiguous,
        ...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
      })
      if (failure.retryable) throw error
    }
  })
}

export function _setProspectCorrespondenceProviderForTesting(
  provider: CorrespondenceProvider | null | undefined,
): void {
  testProvider = provider
  gmailProvider = undefined
}

export function prospectSendOperationFingerprint(outboxId: string): string {
  return createHash('sha256').update(`torchiko-prospect-outbox-v2:${outboxId}`).digest('hex')
}
