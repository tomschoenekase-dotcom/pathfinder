import {
  assertExternalRefScope,
  assertMailboxScope,
  assertSafeHeader,
  MAX_PROVIDER_ATTACHMENTS,
  normalizeUntrustedCorrespondenceBody,
} from './content-safety'
import type { CorrespondenceProvider } from './provider'
import {
  checkedLaunchAttachments,
  launchMimeBoundary,
  launchMimeParts,
  matchesLaunchAttachments,
} from './venue-launch-mime'
import {
  CorrespondenceProviderError,
  type CorrespondenceAddress,
  type FrozenCorrespondence,
  type NormalizedProviderMessage,
  type ProviderExternalRef,
  type ProviderMailboxRef,
  type ProviderSendResult,
  type SendOperationExpectation,
  type SendOperationLookup,
} from './types'

type GmailSendOperationLookupInput = Parameters<
  CorrespondenceProvider['lookupSendOperation']
>[0] & {
  expected?: SendOperationExpectation
}
type GmailCorrespondenceProvider = CorrespondenceProvider &
  Readonly<{
    lookupSendOperation(input: GmailSendOperationLookupInput): Promise<SendOperationLookup>
  }>

export type GmailAuthorizationLease = Readonly<{
  /** The callback scope is the only place where a decrypted access token is exposed. */
  withAccessToken<T>(callback: (accessToken: string) => Promise<T>): Promise<T>
}>

export type GmailCredentialLeaseProvider = Readonly<{
  lease(credentialRef: string): Promise<GmailAuthorizationLease>
}>

export type GmailApiMessage = Readonly<{
  id: string
  threadId: string
  internalDateMs: number
  labelIds: readonly string[]
  headers: Readonly<Record<string, string | undefined>>
  textBody?: string | null
  htmlBody?: string | null
  attachments?: readonly Readonly<{
    id: string
    filename: string
    mimeType: string
    sizeBytes: number
    contentBase64Url?: string
  }>[]
  duplicateCriticalHeaders?: readonly string[]
  hasUnexpectedMimeParts?: boolean
}>

export class GmailApiError extends Error {
  constructor(
    readonly kind:
      | 'AUTHENTICATION'
      | 'RATE_LIMIT'
      | 'TRANSIENT'
      | 'NOT_FOUND'
      | 'HISTORY_CURSOR_EXPIRED'
      | 'PERMANENT',
    message: string,
    readonly acceptance: 'NOT_ACCEPTED' | 'MAY_HAVE_ACCEPTED' = 'NOT_ACCEPTED',
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'GmailApiError'
  }
}

/**
 * Boundary implemented by the runtime Gmail HTTP/client-library transport. It receives only a
 * short-lived access token; refresh tokens remain inside the encrypted credential service.
 */
export type GmailApiClient = Readonly<{
  sendMessage(input: {
    accessToken: string
    mailboxAddress: string
    rawBase64Url: string
    threadId?: string
  }): Promise<{ id: string; threadId: string }>
  getMessage(input: {
    accessToken: string
    mailboxAddress: string
    messageId: string
  }): Promise<GmailApiMessage>
  getThread(input: {
    accessToken: string
    mailboxAddress: string
    threadId: string
  }): Promise<readonly GmailApiMessage[]>
  listHistory(input: {
    accessToken: string
    mailboxAddress: string
    startHistoryId: string
    pageToken?: string
    pageSize: number
  }): Promise<{ messages: readonly GmailApiMessage[]; historyId: string; nextPageToken?: string }>
  listMessages(input: {
    accessToken: string
    mailboxAddress: string
    after: Date
    pageToken?: string
    pageSize: number
  }): Promise<{ messages: readonly GmailApiMessage[]; historyId: string; nextPageToken?: string }>
  watch(input: {
    accessToken: string
    mailboxAddress: string
    topicName: string
  }): Promise<{ historyId: string; expirationMs: number }>
  stopWatch(input: { accessToken: string; mailboxAddress: string }): Promise<void>
  findByRfcMessageId(input: {
    accessToken: string
    mailboxAddress: string
    rfcMessageId: string
    expectedAttachments?: readonly import('@pathfinder/contracts/venue-launch-asset').VenueLaunchAsset[]
  }): Promise<readonly GmailApiMessage[]>
  getProfile(input: {
    accessToken: string
    mailboxAddress: string
  }): Promise<{ emailAddress: string; historyId: string }>
}>

type CorrespondenceCapability =
  CorrespondenceProvider['capabilities'] extends ReadonlySet<infer T> ? T : never

const GMAIL_CAPABILITIES = new Set<CorrespondenceCapability>([
  'SEND_ONE',
  'READ_MESSAGE',
  'READ_THREAD',
  'INCREMENTAL_SYNC',
  'FULL_RECONCILIATION',
  'MAILBOX_WATCH',
  'AMBIGUOUS_SEND_LOOKUP',
  'HEALTH',
])

function parseAddress(value: string | undefined): readonly CorrespondenceAddress[] {
  if (!value) return []
  const parts: string[] = []
  let start = 0
  let quoted = false
  let angleDepth = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '"' && value[index - 1] !== '\\') quoted = !quoted
    else if (!quoted && character === '<') angleDepth += 1
    else if (!quoted && character === '>' && angleDepth > 0) angleDepth -= 1
    else if (!quoted && angleDepth === 0 && character === ',') {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(?:"?([^"<]*)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/u.exec(part)
      if (match?.[2]) {
        const displayName = match[1]?.trim()
        return displayName ? { email: match[2], displayName } : { email: match[2] }
      }
      return { email: part }
    })
}

function parseReferences(value: string | undefined) {
  return value?.match(/<[^<>\s]+>/gu) ?? []
}

function externalRef(mailbox: ProviderMailboxRef, externalId: string): ProviderExternalRef {
  return {
    provider: 'GMAIL',
    providerAccountId: mailbox.providerAccountId,
    mailboxId: mailbox.mailboxId,
    externalId,
  }
}

function normalize(
  mailbox: ProviderMailboxRef,
  message: GmailApiMessage,
): NormalizedProviderMessage {
  const from = parseAddress(message.headers.from)
  const fromMailbox = from.some(
    (address) => address.email.toLowerCase() === mailbox.mailboxAddress.toLowerCase(),
  )
  return {
    message: externalRef(mailbox, message.id),
    thread: externalRef(mailbox, message.threadId),
    rfcMessageId: message.headers['message-id'] ?? null,
    inReplyTo: message.headers['in-reply-to'] ?? null,
    references: parseReferences(message.headers.references),
    from,
    to: parseAddress(message.headers.to),
    cc: parseAddress(message.headers.cc),
    bcc: parseAddress(message.headers.bcc),
    subject: (message.headers.subject ?? '').slice(0, 998),
    internalDate: new Date(message.internalDateMs),
    direction: from.length === 0 ? 'UNKNOWN' : fromMailbox ? 'OUTBOUND' : 'INBOUND',
    body: normalizeUntrustedCorrespondenceBody({
      ...(message.textBody !== undefined ? { text: message.textBody } : {}),
      ...(message.htmlBody !== undefined ? { html: message.htmlBody } : {}),
    }),
    attachments: (message.attachments ?? [])
      .slice(0, MAX_PROVIDER_ATTACHMENTS)
      .map((attachment) => ({
        providerAttachmentId: attachment.id,
        filename: attachment.filename.slice(0, 512),
        mimeType: attachment.mimeType.slice(0, 255),
        sizeBytes: Math.max(0, attachment.sizeBytes),
        downloadPolicy: 'METADATA_ONLY' as const,
      })),
  }
}

function formatAddress(address: CorrespondenceAddress) {
  const email = assertSafeHeader(address.email, 'Email address', 320)
  return address.displayName
    ? `"${assertSafeHeader(address.displayName, 'Display name', 200).replaceAll('"', '\\"')}" <${email}>`
    : email
}

function sameEmail(left: string | undefined, right: string) {
  return typeof left === 'string' && left.trim().toLowerCase() === right.trim().toLowerCase()
}

function canonicalBody(value: string) {
  return value.replace(/\r\n?/gu, '\n')
}

function matchesRecoveryEnvelope(
  mailbox: ProviderMailboxRef,
  candidate: GmailApiMessage,
  rfcMessageId: string,
  expected: SendOperationExpectation,
) {
  const expectedAttachments = checkedLaunchAttachments(expected.attachments)
  const recovered = candidate.attachments ?? []
  const exactAttachments =
    expectedAttachments.length === 0
      ? recovered.length === 0 && candidate.hasUnexpectedMimeParts !== true
      : candidate.hasUnexpectedMimeParts !== true &&
        matchesLaunchAttachments(
          expectedAttachments,
          recovered.flatMap((item) =>
            item.contentBase64Url === undefined
              ? []
              : [
                  {
                    filename: item.filename,
                    mimeType: item.mimeType,
                    sizeBytes: item.sizeBytes,
                    contentBase64Url: item.contentBase64Url,
                  },
                ],
          ),
        ) &&
        recovered.length === expectedAttachments.length
  const from = parseAddress(candidate.headers.from)
  const to = parseAddress(candidate.headers.to)
  let expectedSubject: string
  let candidateSubject: string
  try {
    expectedSubject = assertSafeHeader(expected.subject, 'Subject')
    candidateSubject = assertSafeHeader(candidate.headers.subject ?? '', 'Subject')
  } catch {
    return false
  }
  return (
    candidate.labelIds.includes('SENT') &&
    (candidate.duplicateCriticalHeaders?.length ?? 0) === 0 &&
    exactAttachments &&
    candidate.headers['message-id'] === rfcMessageId &&
    (expected.providerThreadId === undefined || candidate.threadId === expected.providerThreadId) &&
    (expected.inReplyTo === undefined || candidate.headers['in-reply-to'] === expected.inReplyTo) &&
    (expected.references === undefined ||
      JSON.stringify(parseReferences(candidate.headers.references)) ===
        JSON.stringify(expected.references)) &&
    from.length === 1 &&
    sameEmail(from[0]?.email, mailbox.mailboxAddress) &&
    sameEmail(from[0]?.email, expected.senderEmail) &&
    to.length === 1 &&
    sameEmail(to[0]?.email, expected.recipientEmail) &&
    parseAddress(candidate.headers.cc).length === 0 &&
    parseAddress(candidate.headers.bcc).length === 0 &&
    !candidate.htmlBody &&
    candidateSubject === expectedSubject &&
    typeof candidate.textBody === 'string' &&
    canonicalBody(candidate.textBody) === canonicalBody(expected.textBody)
  )
}

function buildRawMessage(message: FrozenCorrespondence) {
  const attachments = checkedLaunchAttachments(message.attachments)
  if (message.from.email.toLowerCase() !== message.mailbox.mailboxAddress.toLowerCase()) {
    throw new CorrespondenceProviderError(
      'INVALID_INPUT',
      'Frozen sender must match the connected mailbox identity',
    )
  }
  if (!/^<[^<>\s]+@[^<>\s]+>$/u.test(message.rfcMessageId)) {
    throw new CorrespondenceProviderError('INVALID_INPUT', 'RFC Message-ID is invalid')
  }
  const headers = [
    `From: ${formatAddress(message.from)}`,
    `To: ${formatAddress(message.recipient)}`,
    `Subject: ${assertSafeHeader(message.subject, 'Subject')}`,
    `Message-ID: ${assertSafeHeader(message.rfcMessageId, 'Message-ID', 998)}`,
    'MIME-Version: 1.0',
    ...(attachments.length === 0
      ? ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit']
      : [
          `Content-Type: multipart/mixed; boundary="${launchMimeBoundary(message.operationId, message.rfcMessageId)}"`,
        ]),
  ]
  if (message.replyTo) headers.splice(2, 0, `Reply-To: ${formatAddress(message.replyTo)}`)
  if (message.inReplyTo)
    headers.push(`In-Reply-To: ${assertSafeHeader(message.inReplyTo, 'In-Reply-To')}`)
  if (message.references.length > 0) {
    headers.push(
      `References: ${message.references
        .map((reference) => assertSafeHeader(reference, 'References'))
        .join(' ')}`,
    )
  }
  // HTML is deliberately not sent by this foundation until a reviewed sanitizer/template path
  // proves it is safe. The immutable text snapshot remains the canonical first-release body.
  const body =
    attachments.length === 0
      ? message.textBody
      : launchMimeParts(
          message.textBody,
          attachments,
          launchMimeBoundary(message.operationId, message.rfcMessageId),
        )
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url')
}

function mapError(error: unknown): never {
  if (!(error instanceof GmailApiError)) throw error
  if (error.acceptance === 'MAY_HAVE_ACCEPTED') {
    throw new CorrespondenceProviderError('AMBIGUOUS_SEND', error.message)
  }
  const code = {
    AUTHENTICATION: 'AUTHENTICATION_REQUIRED',
    RATE_LIMIT: 'RATE_LIMITED',
    TRANSIENT: 'TRANSIENT',
    NOT_FOUND: 'NOT_FOUND',
    HISTORY_CURSOR_EXPIRED: 'HISTORY_CURSOR_EXPIRED',
    PERMANENT: 'PERMANENT',
  }[error.kind] as ConstructorParameters<typeof CorrespondenceProviderError>[0]
  throw new CorrespondenceProviderError(code, error.message, error.retryAfterMs)
}

export function createGmailCorrespondenceProvider(dependencies: {
  credentials: GmailCredentialLeaseProvider
  client: GmailApiClient
  now?: () => Date
}): GmailCorrespondenceProvider {
  const now = dependencies.now ?? (() => new Date())
  const authorized = async <T>(mailbox: ProviderMailboxRef, fn: (token: string) => Promise<T>) => {
    assertMailboxScope('GMAIL', mailbox.provider)
    if (!mailbox.credentialRef) {
      throw new CorrespondenceProviderError('NOT_CONFIGURED', 'Gmail credential is not configured')
    }
    const lease = await dependencies.credentials.lease(mailbox.credentialRef)
    try {
      return await lease.withAccessToken(fn)
    } catch (error) {
      return mapError(error)
    }
  }

  return {
    key: 'GMAIL',
    capabilities: GMAIL_CAPABILITIES,
    async sendOne(message) {
      if (message.mailbox.provider !== 'GMAIL')
        throw new CorrespondenceProviderError('INVALID_INPUT', 'Gmail mailbox is required')
      const rawBase64Url = buildRawMessage(message)
      const result = await authorized(message.mailbox, (accessToken) =>
        dependencies.client.sendMessage({
          accessToken,
          mailboxAddress: message.mailbox.mailboxAddress,
          rawBase64Url,
          ...(message.providerThreadId ? { threadId: message.providerThreadId } : {}),
        }),
      )
      return {
        operationId: message.operationId,
        message: externalRef(message.mailbox, result.id),
        thread: externalRef(message.mailbox, result.threadId),
        rfcMessageId: message.rfcMessageId,
        acceptedAt: now(),
      }
    },
    async retrieveMessage(mailbox, message) {
      assertMailboxScope('GMAIL', message.provider)
      assertExternalRefScope(mailbox, message)
      const result = await authorized(mailbox, (accessToken) =>
        dependencies.client.getMessage({
          accessToken,
          mailboxAddress: mailbox.mailboxAddress,
          messageId: message.externalId,
        }),
      )
      return normalize(mailbox, result)
    },
    async retrieveThread(mailbox, thread) {
      assertMailboxScope('GMAIL', thread.provider)
      assertExternalRefScope(mailbox, thread)
      const messages = await authorized(mailbox, (accessToken) =>
        dependencies.client.getThread({
          accessToken,
          mailboxAddress: mailbox.mailboxAddress,
          threadId: thread.externalId,
        }),
      )
      return messages.map((message) => normalize(mailbox, message))
    },
    async syncIncremental(input) {
      const page = await authorized(input.mailbox, (accessToken) =>
        dependencies.client.listHistory({
          accessToken,
          mailboxAddress: input.mailbox.mailboxAddress,
          startHistoryId: input.cursor,
          pageSize: input.pageSize,
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
        }),
      )
      return {
        messages: page.messages.map((message) => normalize(input.mailbox, message)),
        cursor: page.historyId,
        nextPageToken: page.nextPageToken ?? null,
        hasMore: Boolean(page.nextPageToken),
        mode: 'INCREMENTAL',
      }
    },
    async reconcile(input) {
      const page = await authorized(input.mailbox, (accessToken) =>
        dependencies.client.listMessages({
          accessToken,
          mailboxAddress: input.mailbox.mailboxAddress,
          after: input.after,
          pageSize: input.pageSize,
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
        }),
      )
      return {
        messages: page.messages.map((message) => normalize(input.mailbox, message)),
        cursor: page.historyId,
        nextPageToken: page.nextPageToken ?? null,
        hasMore: Boolean(page.nextPageToken),
        mode: 'FULL_RECONCILIATION',
      }
    },
    async startWatch(input) {
      const watch = await authorized(input.mailbox, (accessToken) =>
        dependencies.client.watch({
          accessToken,
          mailboxAddress: input.mailbox.mailboxAddress,
          topicName: input.topicName,
        }),
      )
      return {
        provider: 'GMAIL',
        mailboxId: input.mailbox.mailboxId,
        cursor: watch.historyId,
        expiresAt: new Date(watch.expirationMs),
      }
    },
    renewWatch(input) {
      return this.startWatch(input)
    },
    async stopWatch(mailbox) {
      await authorized(mailbox, (accessToken) =>
        dependencies.client.stopWatch({
          accessToken,
          mailboxAddress: mailbox.mailboxAddress,
        }),
      )
    },
    async lookupSendOperation(input: GmailSendOperationLookupInput) {
      const expected = input.expected
      const candidates = await authorized(input.mailbox, (accessToken) =>
        dependencies.client.findByRfcMessageId({
          accessToken,
          mailboxAddress: input.mailbox.mailboxAddress,
          rfcMessageId: input.rfcMessageId,
          ...(expected?.attachments?.length ? { expectedAttachments: expected.attachments } : {}),
        }),
      )
      const matching = expected
        ? candidates.filter((candidate) =>
            matchesRecoveryEnvelope(input.mailbox, candidate, input.rfcMessageId, expected),
          )
        : candidates
      if (matching.length === 0) return { state: 'NOT_FOUND' }
      if (matching.length > 1) {
        return { state: 'AMBIGUOUS', candidateMessageIds: matching.map((item) => item.id) }
      }
      const candidate = matching[0]!
      const result: ProviderSendResult = {
        operationId: input.operationId,
        message: externalRef(input.mailbox, candidate.id),
        thread: externalRef(input.mailbox, candidate.threadId),
        rfcMessageId: candidate.headers['message-id'] ?? input.rfcMessageId,
        acceptedAt: new Date(candidate.internalDateMs),
      }
      return { state: 'FOUND', result }
    },
    async health(mailbox) {
      try {
        const profile = await authorized(mailbox, (accessToken) =>
          dependencies.client.getProfile({
            accessToken,
            mailboxAddress: mailbox.mailboxAddress,
          }),
        )
        const identityMatches =
          profile.emailAddress.toLowerCase() === mailbox.mailboxAddress.toLowerCase()
        return {
          status: identityMatches ? 'HEALTHY' : 'DEGRADED',
          checkedAt: now(),
          cursor: profile.historyId,
          watchExpiresAt: null,
          detail: identityMatches ? null : 'Authenticated Gmail identity does not match mailbox',
        }
      } catch (error) {
        if (
          error instanceof CorrespondenceProviderError &&
          (error.code === 'AUTHENTICATION_REQUIRED' || error.code === 'NOT_CONFIGURED')
        ) {
          return {
            status: 'AUTHENTICATION_REQUIRED',
            checkedAt: now(),
            cursor: null,
            watchExpiresAt: null,
            detail:
              error.code === 'NOT_CONFIGURED'
                ? 'Gmail credentials are not configured.'
                : 'Gmail authentication must be renewed.',
          }
        }
        throw error
      }
    },
  }
}
