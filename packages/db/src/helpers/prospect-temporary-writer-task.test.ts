import { describe, expect, it, vi } from 'vitest'
import { compactTemporaryReplyPreparation } from './prospect-sales-actions'
import { encodeSalesComponent } from './prospect-sales-snapshot'
import { readNativeWriterTask } from './prospect-sales-writer'

const source = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./prospect-sales-snapshot', async (original) => ({
  ...(await original<typeof import('./prospect-sales-snapshot')>()),
  readNativeSalesSnapshot: source.read,
}))

const privateBody = 'PRIVATE_TASK_ONLY_MARKER_7ec1'
const live = {
  schema: 'torchiko.native-sales-components/1',
  nativeSnapshotHash: 'a'.repeat(64), SEND_AUTHORIZED: false, senderAvailable: false,
  blocker: null, gate: { can_prepare: true, decision: 'ENOUGH_EVIDENCE' },
  crosswalk: { nativeSelectionId: 'selection-1', routing: {
    kind: 'email', recipient: 'venue@example.test', routing_id: 'route-1',
  } },
  componentCodeHashes: { bridge: 'code-hash' },
  correspondence: { snapshot: { provider: { name: 'gmail' },
    messages: [{ content: { text: privateBody } }] },
  projection: { thread_id: 'thread-1', snapshot_sha256: 'snapshot-hash',
    reply_to_message_id: 'message-1' } },
  preparation: {
    metadata: { preparation_id: 'prep-1', SEND_AUTHORIZED: false },
    request: { mode: 'reply', purpose: 'Respond to selected point',
      thread_state: { latest_message: { body: privateBody } } },
    writerContext: { WLT_packet_identity: 'wlt',
      approved_language_snapshot: { selected_entries: [] },
      relationship: { latest_message: { body: privateBody } } },
    writerMarkdown: `Current point: ${privateBody}`,
    fileSha256s: { 'writer-context.md': 'b'.repeat(64) },
    businessFreshnessReviewDueAt: null, answerText: 'Discuss one room', SEND_AUTHORIZED: false,
  },
}

describe('temporary source writer export', () => {
  it('reconstructs body-bearing task transiently and holds after source expiry', async () => {
    const stored = compactTemporaryReplyPreparation(live)
    const row = { id: 'prep-1', capturedValue: encodeSalesComponent(stored) }
    const client = {
      prospectSourceEvidence: { findFirst: vi.fn().mockResolvedValue(row) },
      prospectContact: { findMany: vi.fn().mockResolvedValue([]) },
      prospectOutreachDraft: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    source.read.mockResolvedValue({ snapshotHash: live.nativeSnapshotHash,
      suppression: { blocked: false }, venue: { id: 'venue-1' },
      organization: { id: 'org-1' } })
    const { task } = await readNativeWriterTask('venue-1', live, client as never)
    expect(task.writerMarkdown).toContain(privateBody)
    expect(JSON.stringify(row.capturedValue)).not.toContain(privateBody)

    source.read.mockResolvedValue({ snapshotHash: 'changed-after-expiry',
      suppression: { blocked: false }, venue: { id: 'venue-1' },
      organization: { id: 'org-1' } })
    await expect(readNativeWriterTask('venue-1', { ...live,
      blocker: 'GMAIL_BODY_UNAVAILABLE_OR_EXPIRED', preparation: null,
    }, client as never)).rejects.toThrow('TEMPORARY_REPLY_SOURCE_STALE_OR_EXPIRED')
  })
})
