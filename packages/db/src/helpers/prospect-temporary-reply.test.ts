import { describe, expect, it } from 'vitest'
import {
  compactTemporaryReplyPreparation,
  requireCurrentTemporaryReply,
  TEMPORARY_REPLY_RECIPE,
} from './prospect-sales-actions'
import { compactTemporaryMeaningCheck } from './prospect-sales-meaning'

const privateBody = 'PRIVATE_INBOUND_MARKER_62c8f9 only in canonical correspondence'
const component = () => ({
  schema: 'torchiko.native-sales-components/1',
  nativeSnapshotHash: 'source-hash',
  SEND_AUTHORIZED: false,
  senderAvailable: false,
  blocker: null,
  gate: { decision: 'ENOUGH_EVIDENCE', can_prepare: true, facts: privateBody },
  crosswalk: { routing: { kind: 'email', recipient: 'venue@example.test' } },
  componentCodeHashes: { bridge: 'code-hash' },
  correspondence: {
    snapshot: {
      provider: { name: 'gmail' },
      messages: [{ content: { text: privateBody } }],
    },
    projection: {
      thread_id: 'thread-1', snapshot_sha256: 'thread-hash',
      reply_to_message_id: 'message-1', live_points: [{ quote: privateBody }],
    },
  },
  preparation: {
    metadata: { preparation_id: 'prep-1', SEND_AUTHORIZED: false, facts: privateBody },
    request: { mode: 'reply', purpose: 'Respond to the selected point',
      thread_state: { latest_message: { body: privateBody } } },
    writerContext: {
      WLT_packet_identity: 'wlt-hash', approved_language_snapshot: { selected_entries: [] },
      research_snapshot: 'research-hash', writer_context_sha256: 'context-hash',
      relationship: { latest_message: { body: privateBody } },
      allowed_claims: [{ text: privateBody }],
    },
    writerMarkdown: privateBody,
    wltRequest: { context: privateBody },
    wltResult: { context: privateBody },
    researchSnapshot: { context: privateBody },
    fileSha256s: { 'writer-context.md': 'file-hash' },
    businessFreshnessReviewDueAt: null,
    answerText: 'Discuss only one room',
    SEND_AUTHORIZED: false,
  },
})

describe('temporary Gmail reply preparation storage', () => {
  it('persists a bounded recipe without inbound body or derived copies', () => {
    const live = component()
    const compact = compactTemporaryReplyPreparation(live)
    expect(JSON.stringify(compact)).not.toContain(privateBody)
    expect((compact.retentionRecipe as { schema: string }).schema).toBe(TEMPORARY_REPLY_RECIPE)
    expect(() => requireCurrentTemporaryReply(compact, live)).not.toThrow()
  })

  it('holds changed, expired, or unavailable canonical source before task export', () => {
    const live = component()
    const compact = compactTemporaryReplyPreparation(live)
    expect(() => requireCurrentTemporaryReply(compact, {
      ...live, correspondence: { ...live.correspondence,
        snapshot: { ...live.correspondence.snapshot, messages: [] } },
    })).toThrow('TEMPORARY_REPLY_SOURCE_STALE_OR_EXPIRED')
    expect(() => requireCurrentTemporaryReply(compact, { ...live,
      preparation: { ...live.preparation, fileSha256s: { 'writer-context.md': 'changed' } },
    })).toThrow('TEMPORARY_REPLY_SOURCE_STALE_OR_EXPIRED')
    expect(() => requireCurrentTemporaryReply(compact, { ...live,
      blocker: 'GMAIL_BODY_UNAVAILABLE_OR_EXPIRED', preparation: null,
    })).toThrow('TEMPORARY_REPLY_SOURCE_STALE_OR_EXPIRED')
  })

  it('keeps permanent meaning findings while removing inbound source quotations', () => {
    const compact = compactTemporaryMeaningCheck({
      schema: 'torchiko.native-composer-meaning/1', status: 'BLOCKED',
      reviewer: { kind: 'model', identity: 'Sol' },
      findings: [{ code: 'SOURCE_UNCLEAR', detail: privateBody }],
      unresolvedHolds: [privateBody], operationalHolds: [privateBody],
      claimEvidence: [{ quote: privateBody }],
      annotations: [{ quote: privateBody }],
    })
    expect(JSON.stringify(compact)).not.toContain(privateBody)
    expect(compact.findings).toHaveLength(1)
    expect(compact.unresolvedHolds).toHaveLength(1)
    expect(compact.claimEvidence).toEqual([])
  })
})
