import { linkInboundClientReply, type ClientInboundLinkResult } from '@pathfinder/db'

import type { NormalizedProviderMessage } from './types'

/**
 * Hands one normalized, provider-neutral inbound message to the client-reply linker. The linker
 * decides from strong identifiers only (see packages/db client-inbound-replies); this adapter just
 * maps the shape and never reads message content for any decision.
 */
export type ClientReplyLinker = (
  message: NormalizedProviderMessage,
) => Promise<ClientInboundLinkResult>

/** A `UNMATCHED` result means the caller may try another matcher; nothing has been recorded. */
export function createClientReplyLinker(options?: {
  quarantineUnknown?: boolean
}): ClientReplyLinker {
  return (message) =>
    linkInboundClientReply(
      {
        provider: message.message.provider,
        mailboxId: message.message.mailboxId,
        providerMessageId: message.message.externalId,
        providerThreadId: message.thread.externalId,
        rfcMessageId: message.rfcMessageId,
        inReplyTo: message.inReplyTo,
        references: message.references,
        fromAddress: message.from[0]?.email ?? '',
        bodyText: message.body.text,
        htmlBytes: message.body.html ? Buffer.byteLength(message.body.html, 'utf8') : 0,
        bodyTruncated: message.body.truncated,
        receivedAt: message.internalDate,
      },
      undefined,
      { quarantineUnknown: options?.quarantineUnknown ?? true },
    )
}
