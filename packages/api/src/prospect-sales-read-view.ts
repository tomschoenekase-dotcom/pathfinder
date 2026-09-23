import { createHash } from 'node:crypto'
import { projectReplyText, nativeWithReplyProjections, type NativeSalesSnapshot } from '@pathfinder/db'
export { nativeWithReplyProjections }

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** A bounded view of existing owners, never an authority-bearing snapshot.
 * Source timestamps remain record timestamps unless an admitted capture says otherwise.
 * No provider credentials, raw capture blobs, all-prospect export or quoted old chain. */
export function projectNativeCrmRead(native: NativeSalesSnapshot) {
  return {
    schema: 'torchiko.native-crm-read/1' as const,
    nativeSnapshotHash: native.snapshotHash,
    venue: {
      id: native.venue.id, organizationId: native.organization.id,
      name: native.venue.name, city: native.venue.city, region: native.venue.region,
      website: native.venue.website,
    },
    sourceReferences: native.sources.map((source) => ({
      id: source.id, type: source.sourceType, label: source.sourceLabel,
      url: source.sourceUrl, recordedAt: source.createdAt,
      recordTimestampIsRetrievalDate: false,
    })),
    importLineage: native.importRecords.map((row) => ({
      id: row.id, recordKind: row.recordKind, externalRecordId: row.externalRecordId,
      sourceWorkbookHash: row.sourceWorkbookHash, recordHash: row.recordHash,
      venueId: row.canonicalVenueId, contactId: row.canonicalContactId,
      evidenceId: row.canonicalEvidenceId, locator: obj(obj(row.rawPayload)._source),
      workbookAssertionIsWebsiteVerification: false,
    })),
    correspondence: native.threads.map((thread) => ({
      id: thread.id, lastMessageAt: thread.lastMessageAt,
      totalRetainedMessages: thread._count.messages,
      omittedFromThisRead: Math.max(0, thread._count.messages - Math.min(thread.messages.length, 20)),
      historyCompleteForPreparation: thread._count.messages === thread.messages.length,
      providerMappings: thread.providerMappings.map((mapping) => ({
        providerAccountId: mapping.providerAccountId,
        providerThreadId: mapping.providerThreadId,
        provider: mapping.providerAccount.provider,
        mailboxAddress: mapping.providerAccount.mailboxAddress,
        connectionStatus: mapping.providerAccount.connectionStatus,
      })),
      messages: thread.messages.slice(-20).map((message) => {
        const raw = message.textBody
        const projected = raw === null ? null : projectReplyText(raw)
        return {
          id: message.id, providerAccountId: message.providerAccountId,
          providerMessageId: message.providerMessageId,
          internetMessageId: message.internetMessageId, inReplyTo: message.inReplyTo,
          references: message.references, direction: message.direction, status: message.status,
          fromAddress: message.fromAddress, toAddresses: message.toAddresses,
          subject: message.subject, occurredAt: message.occurredAt,
          sourceReference: message.sourceReference, bodyRetentionState: message.bodyRetentionState,
          rawBodySha256: raw === null ? null : hash(raw),
          bodyExcerpt: (projected?.text ?? message.bodyPreview ?? '').slice(0, 2500),
          completeForWriter: projected !== null && projected.text.length <= 2500,
          omittedQuotedText: projected?.omittedQuotedText ?? null,
          projectionScope: projected?.scope ?? 'BODY_NOT_RETAINED_USE_EXISTING_SOURCE_OWNER',
          synthetic: (message.sourceReference ?? '').startsWith('synthetic:'),
          humanDisposition: message.inboundReplyDisposition,
          humanReviewId: message.inboundReplyReviewId,
        }
      }),
    })),
    notice: 'Bounded read projection only. Raw bodies/source references remain with their original owner. Unknown quotation formats are not certified clean. Use the exact writer task, not this excerpt, for versioned submission.',
    SEND_AUTHORIZED: false as const,
  }
}

export type NativeCrmReadView = ReturnType<typeof projectNativeCrmRead>
