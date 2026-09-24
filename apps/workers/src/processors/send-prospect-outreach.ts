import { launchAttachmentsFromSnapshot } from '@pathfinder/contracts/venue-launch-asset-node'
import { createHash, randomUUID } from 'node:crypto'

import type { CorrespondenceProvider, FrozenCorrespondence } from '@pathfinder/api/correspondence'
import type { ProviderSendResult } from '@pathfinder/api/correspondence'
import {
  CorrespondenceProviderError,
  createGmailApiClient,
  createGmailCorrespondenceProvider,
  createGmailOAuthRuntime,
} from '@pathfinder/api/correspondence'
import {
  db,
  claimProspectAmbiguousRecoveryAction,
  claimProspectSendOutboxAction,
  PROSPECT_OUTREACH_COMPANY_SENDER,
  recordProspectSendFailureAction,
  recordProspectSendSuccessAction,
  revalidateProspectSendOutboxClaimAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import type { SendProspectOutreachJobPayload } from '@pathfinder/jobs'
import { localFirstSendRehearsalEnabled, type NativeOriginVerifier } from '@pathfinder/db'

let testProvider: CorrespondenceProvider | null | undefined
let gmailProvider: CorrespondenceProvider | null | undefined
let testAfterAcceptance: (() => void) | undefined

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
  if (localFirstSendRehearsalEnabled() && (key !== 'FAKE' || testProvider?.key !== 'FAKE'))
    throw new CorrespondenceProviderError(
      'NOT_CONFIGURED',
      'Local rehearsal has no Gmail or external provider capability',
    )
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
} {
  if (error instanceof CorrespondenceProviderError) {
    return {
      code: error.code,
      retryable: ['RATE_LIMITED', 'TRANSIENT'].includes(error.code),
      acceptanceAmbiguous: error.code === 'AMBIGUOUS_SEND',
      ...(error.retryAfterMs
        ? { retryAt: new Date(Date.now() + Math.min(error.retryAfterMs, 86_400_000)) }
        : {}),
    }
  }
  return {
    code: 'UNCLASSIFIED_PROVIDER_FAILURE',
    retryable: false,
    acceptanceAmbiguous: true,
  }
}

/**
 * Gmail has no native idempotency key. A repeated durable attempt therefore reconciles by
 * deterministic RFC Message-ID and never blindly calls send again.
 */
export async function sendOrRecoverProspectCorrespondence(
  correspondence: CorrespondenceProvider,
  frozen: FrozenCorrespondence,
  attemptCount: number,
): Promise<ProviderSendResult> {
  if (attemptCount <= 1)
    return requireExactProviderResult(frozen, await correspondence.sendOne(frozen))
  return recoverProspectCorrespondence(correspondence, frozen)
}

/** Provider-accepted uncertainty has one legal operation: exact lookup. This
 * function has no sendOne branch even if a malformed outbox attempt count slips
 * through a caller or a database migration. */
export async function recoverProspectCorrespondence(
  correspondence: CorrespondenceProvider,
  frozen: FrozenCorrespondence,
): Promise<ProviderSendResult> {
  const lookup = await correspondence.lookupSendOperation({
    mailbox: frozen.mailbox,
    operationId: frozen.operationId,
    rfcMessageId: frozen.rfcMessageId,
    expected: {
      senderEmail: frozen.from.email,
      recipientEmail: frozen.recipient.email,
      subject: frozen.subject,
      textBody: frozen.textBody,
      attachments: frozen.attachments ?? [],
      ...(frozen.inReplyTo ? { inReplyTo: frozen.inReplyTo } : {}),
      references: frozen.references,
      ...(frozen.providerThreadId ? { providerThreadId: frozen.providerThreadId } : {}),
    },
  })
  if (lookup.state === 'FOUND') return requireExactProviderResult(frozen, lookup.result)
  throw new CorrespondenceProviderError(
    'AMBIGUOUS_SEND',
    lookup.state === 'AMBIGUOUS'
      ? `Prior provider attempt has ${lookup.candidateMessageIds.length} matching messages`
      : 'Prior provider attempt was not found; automatic resend is blocked to prevent duplication',
  )
}

export function requireExactProviderResult(
  frozen: FrozenCorrespondence,
  result: ProviderSendResult,
): ProviderSendResult {
  const refs = [result.message, result.thread]
  if (
    result.operationId !== frozen.operationId ||
    result.rfcMessageId !== frozen.rfcMessageId ||
    !Number.isFinite(result.acceptedAt?.getTime()) ||
    refs.some(
      (ref) =>
        !ref ||
        !ref.externalId?.trim() ||
        /[\r\n\0]/u.test(ref.externalId) ||
        ref.provider !== frozen.mailbox.provider ||
        ref.providerAccountId !== frozen.mailbox.providerAccountId ||
        ref.mailboxId !== frozen.mailbox.mailboxId,
    ) ||
    (frozen.providerThreadId && result.thread.externalId !== frozen.providerThreadId)
  )
    throw new CorrespondenceProviderError(
      'AMBIGUOUS_SEND',
      'Provider acceptance did not return exact operation/account/message/thread identities; reconciliation required',
    )
  return result
}

export async function processSendProspectOutreachJob(
  payload: SendProspectOutreachJobPayload,
  runtime: { verifyNativeOrigin?: NativeOriginVerifier } = {},
): Promise<void> {
  const deliveryEnabled =
    process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED === 'true' || localFirstSendRehearsalEnabled()
  const workerId = `prospect-worker:${process.pid}:${randomUUID()}`
  await withTenantIsolationBypass(async () => {
    if (!deliveryEnabled) {
      const candidate = await db.prospectSendOutbox.findUnique({
        where: { id: payload.outboxId },
        select: { status: true, attemptCount: true, lastErrorCode: true },
      })
      if (
        !(
          candidate?.status === 'AMBIGUOUS' &&
          candidate.attemptCount > 0 &&
          ['AMBIGUOUS_SEND', 'UNCLASSIFIED_PROVIDER_FAILURE'].includes(
            candidate.lastErrorCode ?? '',
          )
        )
      )
        throw new Error('Prospect outreach delivery is disabled')
    }
    const recovery = await claimProspectAmbiguousRecoveryAction({
      outboxId: payload.outboxId,
      workerId,
    })
    if (!recovery && !deliveryEnabled) throw new Error('Prospect outreach delivery is disabled')
    if (!recovery && !runtime.verifyNativeOrigin) {
      const pending = await db.prospectSendOutbox.findUnique({
        where: { id: payload.outboxId },
        select: { sendItem: { select: { headerSnapshot: true } } },
      })
      const header = pending?.sendItem.headerSnapshot as Record<string, unknown> | undefined
      if (header?.nativeSalesOrigin)
        throw new CorrespondenceProviderError(
          'NOT_CONFIGURED',
          'Native-origin dispatch requires the trusted persisted-preparation and current-business-source verifier at worker composition. No claim or provider send was attempted; retained approval does not replace current evidence.',
        )
    }
    const claimed =
      recovery ??
      (await claimProspectSendOutboxAction(
        {
          outboxId: payload.outboxId,
          workerId,
        },
        undefined,
        runtime.verifyNativeOrigin,
      ))
    if (!claimed) return
    if (
      claimed.attemptCount <= 1 &&
      claimed.mailboxAddress.trim().toLowerCase() !== PROSPECT_OUTREACH_COMPANY_SENDER
    ) {
      await recordProspectSendFailureAction({
        outboxId: claimed.outboxId,
        workerId,
        code: 'UNEXPECTED_SENDER',
        retryable: false,
        acceptanceAmbiguous: false,
      })
      return
    }
    if (claimed.attemptCount <= 1 && !isProspectRecipientAllowed(claimed.recipient)) {
      await recordProspectSendFailureAction({
        outboxId: claimed.outboxId,
        workerId,
        code: 'INTERNAL_RECIPIENT_ALLOWLIST_BLOCKED',
        retryable: false,
        acceptanceAmbiguous: false,
      })
      return
    }
    const headers =
      claimed.headers && typeof claimed.headers === 'object'
        ? (claimed.headers as Record<string, unknown>)
        : {}
    const origin = headers.nativeSalesOrigin as
      | { reply?: { providerThreadId: string; inReplyTo: string; references: string[] } }
      | undefined
    const reply = origin?.reply
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
      attachments: claimed.launchAttachments,
      // Reviewed HTML sanitization is not mounted. Prospect delivery is text-only in this release.
      rfcMessageId: `<torchiko.${claimed.operationId}@torchiko.com>`,
      references: reply?.references ?? [],
      ...(reply ? { inReplyTo: reply.inReplyTo, providerThreadId: reply.providerThreadId } : {}),
    }
    let providerAttempted = false
    try {
      const correspondence = providerForRuntime(claimed.provider)
      if (!recovery) {
        const stillAuthorized = await revalidateProspectSendOutboxClaimAction(
          {
            outboxId: claimed.outboxId,
            workerId,
          },
          undefined,
          runtime.verifyNativeOrigin,
        )
        if (!stillAuthorized) return
      }
      providerAttempted = true
      const result = recovery
        ? await recoverProspectCorrespondence(correspondence, frozen)
        : await sendOrRecoverProspectCorrespondence(correspondence, frozen, claimed.attemptCount)
      if (localFirstSendRehearsalEnabled()) testAfterAcceptance?.()
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
      const acceptanceAmbiguous = providerAttempted && failure.acceptanceAmbiguous
      await recordProspectSendFailureAction({
        outboxId: claimed.outboxId,
        workerId,
        code: failure.code,
        retryable: failure.retryable,
        acceptanceAmbiguous,
        ...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
      })
      if (failure.retryable || acceptanceAmbiguous) throw error
    }
  })
}

export function _setProspectCorrespondenceProviderForTesting(
  provider: CorrespondenceProvider | null | undefined,
): void {
  testProvider = provider
  gmailProvider = undefined
}

/** Fault injection is inert outside the isolated disposable rehearsal gate. */
export function _setProspectAfterAcceptanceFaultForTesting(hook: (() => void) | undefined): void {
  testAfterAcceptance = hook
}

export function prospectSendOperationFingerprint(outboxId: string): string {
  return createHash('sha256').update(`torchiko-prospect-outbox-v2:${outboxId}`).digest('hex')
}
