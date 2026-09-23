import type { CorrespondenceProvider } from './provider'
import { checkedLaunchAttachments } from './venue-launch-mime'
import { normalizeUntrustedCorrespondenceBody } from './content-safety'
import type {
  FrozenCorrespondence,
  NormalizedProviderMessage,
  ProviderExternalRef,
  ProviderMailboxRef,
  ProviderSendResult,
  SendOperationExpectation,
} from './types'
import { CorrespondenceProviderError } from './types'

export type FakeCorrespondenceState = {
  sent: FrozenCorrespondence[]
  messages: Map<string, NormalizedProviderMessage>
  failures: Map<string, Error>
}

function ref(mailbox: ProviderMailboxRef, id: string): ProviderExternalRef {
  return {
    provider: 'FAKE',
    providerAccountId: mailbox.providerAccountId,
    mailboxId: mailbox.mailboxId,
    externalId: id,
  }
}

export function createFakeCorrespondenceProvider(input?: {
  state?: FakeCorrespondenceState
  now?: () => Date
}): CorrespondenceProvider & { state: FakeCorrespondenceState } {
  const state: FakeCorrespondenceState = input?.state ?? {
    sent: [],
    messages: new Map(),
    failures: new Map(),
  }
  const now = input?.now ?? (() => new Date('2026-08-20T12:00:00.000Z'))
  const capabilities = new Set([
    'SEND_ONE',
    'READ_MESSAGE',
    'READ_THREAD',
    'INCREMENTAL_SYNC',
    'FULL_RECONCILIATION',
    'MAILBOX_WATCH',
    'AMBIGUOUS_SEND_LOOKUP',
    'HEALTH',
  ] as const)
  const provider: CorrespondenceProvider & { state: FakeCorrespondenceState } = {
    key: 'FAKE',
    capabilities,
    state,
    async sendOne(message) {
      const attachments = checkedLaunchAttachments(message.attachments)
      const previous = state.sent.find((item) => item.providerIdempotencyKey === message.providerIdempotencyKey)
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(message)) throw new CorrespondenceProviderError(
          'INVALID_INPUT', 'Fake idempotency payload changed',
        )
        const retained = state.messages.get(`message-${message.operationId}`)
        if (!retained) throw new CorrespondenceProviderError('PERMANENT', 'Fake accepted message missing')
        return { operationId: message.operationId, message: retained.message,
          thread: retained.thread, rfcMessageId: message.rfcMessageId, acceptedAt: retained.internalDate }
      }
      const failure = state.failures.get(message.operationId)
      if (failure) throw failure
      state.sent.push(structuredClone(message))
      const result: ProviderSendResult = {
        operationId: message.operationId,
        message: ref(message.mailbox, `message-${message.operationId}`),
        thread: ref(message.mailbox, message.providerThreadId ?? `thread-${message.operationId}`),
        rfcMessageId: message.rfcMessageId,
        acceptedAt: now(),
      }
      state.messages.set(result.message.externalId, {
        message: result.message,
        thread: result.thread,
        rfcMessageId: result.rfcMessageId,
        inReplyTo: message.inReplyTo ?? null,
        references: message.references,
        from: [message.from],
        to: [message.recipient],
        cc: [],
        bcc: [],
        subject: message.subject,
        internalDate: result.acceptedAt,
        direction: 'OUTBOUND',
        body: normalizeUntrustedCorrespondenceBody({ text: message.textBody }),
        attachments: attachments.map((asset, index) => ({
          providerAttachmentId: `fake-attachment-${index}`, filename: asset.filename,
          mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, downloadPolicy: 'METADATA_ONLY' as const,
        })),
      })
      return result
    },
    async retrieveMessage(_mailbox, message) {
      const result = state.messages.get(message.externalId)
      if (!result) throw new Error('Fake message not found')
      return result
    },
    async retrieveThread(_mailbox, thread) {
      return [...state.messages.values()].filter(
        (message) => message.thread.externalId === thread.externalId,
      )
    },
    async syncIncremental() {
      return {
        messages: [...state.messages.values()],
        cursor: 'fake-cursor',
        nextPageToken: null,
        hasMore: false,
        mode: 'INCREMENTAL',
      }
    },
    async reconcile() {
      return {
        messages: [...state.messages.values()],
        cursor: 'fake-cursor',
        nextPageToken: null,
        hasMore: false,
        mode: 'FULL_RECONCILIATION',
      }
    },
    async startWatch({ mailbox }) {
      return {
        provider: 'FAKE',
        mailboxId: mailbox.mailboxId,
        cursor: 'fake-cursor',
        expiresAt: new Date(now().getTime() + 86_400_000),
      }
    },
    renewWatch(input) {
      return this.startWatch(input)
    },
    async stopWatch() {},
    async lookupSendOperation({ mailbox, operationId, rfcMessageId, expected }) {
      const matches = [...state.messages.values()].filter(
        (candidate) =>
          candidate.rfcMessageId === rfcMessageId &&
          candidate.message.providerAccountId === mailbox.providerAccountId &&
          candidate.message.mailboxId === mailbox.mailboxId,
      )
      if (matches.length > 1)
        return { state: 'AMBIGUOUS', candidateMessageIds: matches.map((m) => m.message.externalId) }
      const message = matches[0]
      if (!message) return { state: 'NOT_FOUND' }
      if (expected) {
        const sent = state.sent.find((item) => item.operationId === operationId &&
          item.rfcMessageId === rfcMessageId)
        if (!sent || !matchesFakeExpectation(sent, expected)) return { state: 'NOT_FOUND' }
      }
      return {
        state: 'FOUND',
        result: {
          operationId,
          message: message.message,
          thread: message.thread,
          rfcMessageId,
          acceptedAt: message.internalDate,
        },
      }
    },
    async health() {
      return {
        status: 'HEALTHY',
        checkedAt: now(),
        cursor: 'fake-cursor',
        watchExpiresAt: null,
        detail: null,
      }
    },
  }
  return provider
}

function matchesFakeExpectation(sent: FrozenCorrespondence, expected: SendOperationExpectation) {
  const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  return sameEmail(sent.from.email, expected.senderEmail) &&
    sameEmail(sent.recipient.email, expected.recipientEmail) &&
    sent.subject.trim() === expected.subject.trim() &&
    sent.textBody.replace(/\r\n?/gu, '\n') === expected.textBody.replace(/\r\n?/gu, '\n') &&
    (expected.providerThreadId === undefined || sent.providerThreadId === expected.providerThreadId) &&
    (expected.inReplyTo === undefined || sent.inReplyTo === expected.inReplyTo) &&
    (expected.references === undefined ||
      JSON.stringify(sent.references) === JSON.stringify(expected.references)) &&
    JSON.stringify(checkedLaunchAttachments(sent.attachments)) ===
      JSON.stringify(checkedLaunchAttachments(expected.attachments))
}
