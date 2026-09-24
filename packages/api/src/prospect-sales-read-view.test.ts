import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { nativeWithReplyProjections, projectNativeCrmRead } from './prospect-sales-read-view'
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
function fixture() {
  const raw =
    'NON-SALES reply check: caf\u00e9 \u{1f33f}.\r\n\r\nOn Monday someone wrote:\r\n> retained old diagnostic'
  const native = {
    snapshotHash: 'a'.repeat(64),
    organization: { id: 'SYN-org' },
    venue: {
      id: 'SYN-venue',
      name: 'SYN diagnostic record',
      city: null,
      region: null,
      website: null,
    },
    sources: [
      {
        id: 'SYN-source',
        sourceType: 'fixture',
        sourceLabel: 'Synthetic',
        sourceUrl: null,
        createdAt: '2026-09-21',
      },
    ],
    importRecords: [
      {
        id: 'SYN-import',
        rawPayload: { _source: { sheetName: 'Synthetic', originalRowNumber: 1 } },
      },
    ],
    threads: [
      {
        id: 'SYN-thread',
        lastMessageAt: '2026-09-21',
        _count: { messages: 1 },
        providerMappings: [
          {
            providerAccountId: 'SYN-account',
            providerThreadId: 'SYN-provider-thread',
            providerAccount: {
              provider: 'FAKE',
              mailboxAddress: 'fixture@example.invalid',
              connectionStatus: 'DISCONNECTED',
              credentialReferenceId: 'DO-NOT-EXPORT',
              accessToken: 'DO-NOT-EXPORT',
            },
          },
        ],
        messages: [
          {
            id: 'SYN-message',
            textBody: raw,
            bodyPreview: 'old preview',
            sourceReference: 'synthetic:raw-owner',
            bodyRetentionState: 'TEMPORARY',
            inboundReplyDisposition: 'UNREVIEWED',
            inboundReplyReviewId: null,
          },
        ],
      },
    ],
  }
  return { native, raw }
}
describe('Codex bounded native correspondence read', () => {
  it('preserves raw source and exposes a separately hashed quote-free display', () => {
    const { native, raw } = fixture()
    const before = JSON.stringify(native)
    const value = projectNativeCrmRead(native as never)
    const message = value.correspondence[0]!.messages[0]!
    expect(message.bodyExcerpt).toBe('NON-SALES reply check: caf\u00e9 \u{1f33f}.')
    expect(message.rawBodySha256).toBe(sha(raw))
    expect(message.sourceReference).toBe('synthetic:raw-owner')
    expect(message.omittedQuotedText).toBe(true)
    expect(JSON.stringify(value)).not.toContain('DO-NOT-EXPORT')
    expect(JSON.stringify(native)).toBe(before)
    expect(value.sourceReferences[0]!.recordTimestampIsRetrievalDate).toBe(false)
  })
  it('does not invent a full message from a preview when raw body is not retained', () => {
    const { native } = fixture()
    native.threads[0]!.messages[0]!.textBody = null as never
    const value = projectNativeCrmRead(native as never).correspondence[0]!.messages[0]!
    expect(value.completeForWriter).toBe(false)
    expect(value.rawBodySha256).toBeNull()
  })
  it('reports incomplete history even while showing the latest bounded message', () => {
    const { native } = fixture()
    native.threads[0]!._count.messages = 101
    const thread = projectNativeCrmRead(native as never).correspondence[0]!
    expect(thread.totalRetainedMessages).toBe(101)
    expect(thread.omittedFromThisRead).toBe(100)
    expect(thread.historyCompleteForPreparation).toBe(false)
    expect(thread.messages[0]?.id).toBe('SYN-message')
  })
  it('keeps the native source hash and original bytes while supplying the existing bridge a derivation', () => {
    const { native, raw } = fixture()
    const result = nativeWithReplyProjections(native as never)
    expect(result.snapshotHash).toBe(native.snapshotHash)
    expect(result.threads[0]!.messages[0]!.textBody).toBe(raw)
    expect(result.threads[0]!.messages[0]!.replyProjection!.rawBodySha256).toBe(sha(raw))
    expect(result.threads[0]!.messages[0]!.replyProjection!.text).not.toContain('old diagnostic')
    expect(native.threads[0]!.messages[0]).not.toHaveProperty('replyProjection')
  })
})
