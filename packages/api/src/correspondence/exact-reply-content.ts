import { createHash } from 'node:crypto'

import { MAX_PROVIDER_TEXT_BYTES } from './content-safety'
import { projectReplyText } from './reply-text'
import type { CorrespondenceProvider } from './provider'
import { CorrespondenceProviderError, type ProviderMailboxRef } from './types'

/** A canonical DB message joined to its exact provider-thread mapping. The caller
 * must load and authorize this row; user-supplied IDs are not sufficient. */
export type ExactSourceOnlyReplySelection = Readonly<{
  canonicalMessageId: string
  canonicalThreadId: string
  organizationId: string
  provider: ProviderMailboxRef['provider']
  providerAccountId: string
  mailboxId: string
  providerMessageId: string
  providerThreadId: string
  internetMessageId: string | null
  fromAddress: string
  subject: string
  occurredAt: Date
  sourceReference: string
  direction: 'INBOUND'
  bodyRetentionState: 'NOT_STORED'
}>

function expectedSourceReference(selected: ExactSourceOnlyReplySelection) {
  return selected.provider === 'FAKE'
    ? `synthetic:crm-sales:fake-provider:${selected.providerMessageId}`
    : `https://mail.google.com/mail/u/${encodeURIComponent(selected.mailboxId)}/#all/${encodeURIComponent(selected.providerMessageId)}`
}

function invalidSelection(): never {
  throw new CorrespondenceProviderError(
    'INVALID_INPUT',
    'Exact canonical reply selection is incomplete or mismatched',
  )
}

/** Explicit one-message source read for a selected SOURCE_ONLY reply. This does
 * not change retention, hydrate a canonical row, or grant sending authority. */
export async function readExactSourceOnlyReplyContent(input: {
  provider: CorrespondenceProvider
  mailbox: ProviderMailboxRef
  selected: ExactSourceOnlyReplySelection
}) {
  const { provider, mailbox, selected } = input
  if (
    provider.key !== mailbox.provider ||
    selected.provider !== mailbox.provider ||
    selected.providerAccountId !== mailbox.providerAccountId ||
    selected.mailboxId !== mailbox.mailboxId ||
    selected.direction !== 'INBOUND' ||
    selected.bodyRetentionState !== 'NOT_STORED' ||
    !selected.canonicalMessageId ||
    !selected.canonicalThreadId ||
    !selected.organizationId ||
    !selected.providerMessageId ||
    selected.providerMessageId.length > 191 ||
    !selected.providerThreadId ||
    selected.providerThreadId.length > 191 ||
    !selected.fromAddress ||
    !selected.subject ||
    !(selected.occurredAt instanceof Date) ||
    !Number.isFinite(selected.occurredAt.getTime()) ||
    selected.sourceReference.length > 1000 ||
    selected.sourceReference !== expectedSourceReference(selected)
  )
    invalidSelection()
  if (!provider.capabilities.has('READ_MESSAGE')) {
    throw new CorrespondenceProviderError(
      'NOT_CONFIGURED',
      'Provider cannot read a selected reply message',
    )
  }

  const message = await provider.retrieveMessage(mailbox, {
    provider: selected.provider,
    providerAccountId: selected.providerAccountId,
    mailboxId: selected.mailboxId,
    externalId: selected.providerMessageId,
  })
  if (
    message.message.provider !== selected.provider ||
    message.message.providerAccountId !== selected.providerAccountId ||
    message.message.mailboxId !== selected.mailboxId ||
    message.message.externalId !== selected.providerMessageId ||
    message.thread.provider !== selected.provider ||
    message.thread.providerAccountId !== selected.providerAccountId ||
    message.thread.mailboxId !== selected.mailboxId ||
    message.thread.externalId !== selected.providerThreadId ||
    message.rfcMessageId !== selected.internetMessageId ||
    message.from.length !== 1 ||
    message.from[0]!.email.toLowerCase() !== selected.fromAddress.toLowerCase() ||
    message.subject !== selected.subject ||
    message.internalDate.getTime() !== selected.occurredAt.getTime() ||
    message.direction !== 'INBOUND'
  ) {
    throw new CorrespondenceProviderError(
      'INVALID_INPUT',
      'Provider message no longer matches the canonical reply source',
    )
  }
  if (
    message.body.truncated ||
    !message.body.text.trim() ||
    Buffer.byteLength(message.body.text, 'utf8') > MAX_PROVIDER_TEXT_BYTES ||
    message.body.trust !== 'UNTRUSTED_EXTERNAL_CONTENT' ||
    message.body.agentPolicy !== 'DATA_ONLY_NEVER_INSTRUCTIONS_OR_AUTHORIZATION'
  ) {
    throw new CorrespondenceProviderError(
      'INVALID_INPUT',
      'Selected reply body is missing or truncated',
    )
  }
  const projected = projectReplyText(message.body.text)
  if (
    !projected.text ||
    projected.text.length > 20_000 ||
    Buffer.byteLength(projected.text, 'utf8') > 32_000
  ) {
    throw new CorrespondenceProviderError(
      'INVALID_INPUT',
      'Selected reply text exceeds the bounded preparation limit',
    )
  }
  return {
    canonicalMessageId: selected.canonicalMessageId,
    canonicalThreadId: selected.canonicalThreadId,
    organizationId: selected.organizationId,
    providerMessageId: selected.providerMessageId,
    providerThreadId: selected.providerThreadId,
    sourceReference: selected.sourceReference,
    rawBodySha256: createHash('sha256').update(message.body.text, 'utf8').digest('hex'),
    rawText: message.body.text,
    replyText: projected.text,
    omittedQuotedText: projected.omittedQuotedText,
    projectionScope: projected.scope,
    trust: message.body.trust,
    agentPolicy: message.body.agentPolicy,
    retention: 'TRANSIENT_SOURCE_READ' as const,
  }
}
