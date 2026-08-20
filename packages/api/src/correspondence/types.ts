export const CORRESPONDENCE_PROVIDERS = ['GMAIL', 'FAKE'] as const
export type CorrespondenceProviderKey = (typeof CORRESPONDENCE_PROVIDERS)[number]

export type ProviderMailboxRef = Readonly<{
  provider: CorrespondenceProviderKey
  providerAccountId: string
  mailboxId: string
  mailboxAddress: string
  /** Opaque reference resolved by the encrypted credential service at runtime. */
  credentialRef: string
}>

export type ProviderExternalRef = Readonly<{
  provider: CorrespondenceProviderKey
  providerAccountId: string
  mailboxId: string
  externalId: string
}>

export type CorrespondenceAddress = Readonly<{
  email: string
  displayName?: string
}>

export type FrozenCorrespondence = Readonly<{
  operationId: string
  providerIdempotencyKey: string
  mailbox: ProviderMailboxRef
  recipient: CorrespondenceAddress
  from: CorrespondenceAddress
  replyTo?: CorrespondenceAddress
  subject: string
  textBody: string
  safeHtmlBody?: string
  rfcMessageId: string
  inReplyTo?: string
  references: readonly string[]
  providerThreadId?: string
}>

export type ProviderSendResult = Readonly<{
  operationId: string
  message: ProviderExternalRef
  thread: ProviderExternalRef
  rfcMessageId: string
  acceptedAt: Date
}>

export type UntrustedCorrespondenceBody = Readonly<{
  text: string
  html: string | null
  truncated: boolean
  trust: 'UNTRUSTED_EXTERNAL_CONTENT'
  renderingPolicy: 'TEXT_FIRST_HTML_REQUIRES_SANITIZATION'
  agentPolicy: 'DATA_ONLY_NEVER_INSTRUCTIONS_OR_AUTHORIZATION'
}>

export type NormalizedProviderMessage = Readonly<{
  message: ProviderExternalRef
  thread: ProviderExternalRef
  rfcMessageId: string | null
  inReplyTo: string | null
  references: readonly string[]
  from: readonly CorrespondenceAddress[]
  to: readonly CorrespondenceAddress[]
  cc: readonly CorrespondenceAddress[]
  bcc: readonly CorrespondenceAddress[]
  subject: string
  internalDate: Date
  direction: 'INBOUND' | 'OUTBOUND' | 'UNKNOWN'
  body: UntrustedCorrespondenceBody
  attachments: readonly Readonly<{
    providerAttachmentId: string
    filename: string
    mimeType: string
    sizeBytes: number
    downloadPolicy: 'METADATA_ONLY'
  }>[]
}>

export type ProviderSyncPage = Readonly<{
  messages: readonly NormalizedProviderMessage[]
  /** Durable provider history cursor to persist only after all pages are ingested. */
  cursor: string
  /** Opaque page token; never persist this as the durable history cursor. */
  nextPageToken: string | null
  hasMore: boolean
  mode: 'INCREMENTAL' | 'FULL_RECONCILIATION'
}>

export type ProviderWatch = Readonly<{
  provider: CorrespondenceProviderKey
  mailboxId: string
  cursor: string
  expiresAt: Date
}>

export type ProviderHealth = Readonly<{
  status: 'HEALTHY' | 'DEGRADED' | 'AUTHENTICATION_REQUIRED' | 'DISCONNECTED'
  checkedAt: Date
  cursor: string | null
  watchExpiresAt: Date | null
  detail: string | null
}>

export type SendOperationLookup =
  | Readonly<{ state: 'NOT_FOUND' }>
  | Readonly<{ state: 'FOUND'; result: ProviderSendResult }>
  | Readonly<{ state: 'AMBIGUOUS'; candidateMessageIds: readonly string[] }>

export class CorrespondenceProviderError extends Error {
  constructor(
    readonly code:
      | 'AUTHENTICATION_REQUIRED'
      | 'RATE_LIMITED'
      | 'TRANSIENT'
      | 'INVALID_INPUT'
      | 'NOT_FOUND'
      | 'HISTORY_CURSOR_EXPIRED'
      | 'AMBIGUOUS_SEND'
      | 'NOT_CONFIGURED'
      | 'PERMANENT',
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'CorrespondenceProviderError'
  }
}
