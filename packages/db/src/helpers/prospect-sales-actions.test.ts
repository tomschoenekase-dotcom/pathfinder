import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeSalesComponent,
  encodeSalesComponent,
  nativeContactHeld,
  readNativeSalesRouteSuppression,
  salesHash,
} from './prospect-sales-snapshot'
import { bindNativeWritingReference, persistNativeSalesPreparation, saveNativeSalesDraft } from './prospect-sales-actions'

const state = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./prospect-sales-snapshot', async (original) => ({
  ...(await original<typeof import('./prospect-sales-snapshot')>()),
  readNativeSalesSnapshot: state.read,
}))
const actor = { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'synthetic:crm-sales:unit' } as const
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const snapshotHash = 'a'.repeat(64)
function harness() {
  const drafts: Record<string, unknown>[] = []
  const base = {
    schema: 'torchiko.native-sales-components/1',
    nativeSnapshotHash: snapshotHash,
    SEND_AUTHORIZED: false,
    senderAvailable: false,
    blocker: null,
    gate: { can_prepare: true },
    crosswalk: {
      nativeVenueId: 'venue',
      nativeOrganizationId: 'org',
      nativeContactId: 'candidate',
      routing: {
        kind: 'email',
        recipient: 'candidate@example.invalid',
        routing_id: 'source-route',
      },
    },
    preparation: {
      SEND_AUTHORIZED: false,
      metadata: { SEND_AUTHORIZED: false },
      request: { mode: 'cold' },
      fileSha256s: { context: 'b'.repeat(64) },
      writerContext: {
        WLT_packet_identity: 'bound-wlt',
        approved_language_snapshot: { current_approved_count: 0, selected_entries: [] },
      },
    },
    componentCodeHashes: { owner: 'code-hash' },
  }
  const tx = {
    prospectContact: { findMany: vi.fn().mockResolvedValue([]) },
    prospectSourceEvidence: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'prep',
        venueId: 'venue',
        sourceType: 'CRM_SALES_PREPARATION_V1',
        capturedValue: encodeSalesComponent(base),
      }),
    },
    prospectOutreachDraft: {
      findFirst: vi.fn(async () => drafts.at(-1) ?? null),
      create: vi.fn(async ({ data }) => {
        drafts.push(data)
        return data
      }),
    },
    prospectActivity: { create: vi.fn().mockResolvedValue({ id: 'activity' }) },
  }
  const client = { $transaction: vi.fn(async (fn) => fn(tx)) }
  const input = (subject: string, body: string, expectedDraftId: string | null = null) => ({
    venueId: 'venue',
    preparationId: 'prep',
    expectedSnapshotHash: snapshotHash,
    expectedDraftId,
    subject,
    body,
    actor,
    component: {
      ...base,
      draftCheck: {
        composerDraftSha256: hash(`Subject: ${subject}\n\n${body}\n`),
        bodySha256: hash(body),
        SEND_AUTHORIZED: false,
      },
    },
  })
  return { client, tx, drafts, input }
}

describe('native no-send revision and exact component storage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.read.mockResolvedValue({
      organization: { id: 'org' },
      venue: { id: 'venue' },
      snapshotHash,
      suppression: { blocked: false },
    })
  })
  it('retains exact floating-point WLT bytes across native JSON storage', () => {
    const value = { preparation: { WLT: { score: 17.400000000000002 } }, SEND_AUTHORIZED: false }
    const stored = encodeSalesComponent(value)
    expect(decodeSalesComponent(JSON.parse(JSON.stringify(stored)))).toEqual(value)
    expect(stored.componentJson).toContain('17.400000000000002')
    expect(() =>
      decodeSalesComponent({
        ...stored,
        componentJson: stored.componentJson.replace('17.4', '18.4'),
      }),
    ).toThrow(/immutable hash/)
    expect(decodeSalesComponent(value).schema).toBe('unusable-legacy-preparation')
  })
  it('persists only a recipe for a temporary Gmail reply, never its retained body', async () => {
    const privateBody = 'PRIVATE_INBOUND_DB_MARKER_61ae'
    let persisted: Record<string, unknown> | null = null
    const tx = {
      prospectContact: { findMany: vi.fn().mockResolvedValue([]) },
      prospectSourceEvidence: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          persisted = data
          return data
        }),
      },
      prospectActivity: { create: vi.fn().mockResolvedValue({ id: 'activity' }) },
    }
    const client = { $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) }
    const component = {
      schema: 'torchiko.native-sales-components/1', nativeSnapshotHash: snapshotHash,
      SEND_AUTHORIZED: false, senderAvailable: false, blocker: null,
      gate: { can_prepare: true, decision: 'ENOUGH_EVIDENCE' },
      crosswalk: { nativeVenueId: 'venue', nativeOrganizationId: 'org',
        routing: { kind: 'email', recipient: 'venue@example.test', routing_id: 'route-1' } },
      componentCodeHashes: { bridge: 'hash' },
      correspondence: { snapshot: { provider: { name: 'gmail' }, messages: [{
        content: { text: privateBody },
      }] }, projection: { thread_id: 'thread-1', snapshot_sha256: 'snapshot-hash',
        reply_to_message_id: 'message-1', live_points: [{ quote: privateBody }] } },
      preparation: { SEND_AUTHORIZED: false,
        metadata: { preparation_id: 'prep-1', SEND_AUTHORIZED: false },
        request: { mode: 'reply', purpose: 'Answer the exact point',
          thread_state: { latest_message: { body: privateBody } } },
        writerContext: { WLT_packet_identity: 'wlt', approved_language_snapshot: {},
          relationship: { latest_message: { body: privateBody } } },
        writerMarkdown: privateBody,
        fileSha256s: { context: 'a'.repeat(64) },
        businessFreshnessReviewDueAt: null, answerText: 'Propose one room',
      },
    }
    await persistNativeSalesPreparation({ venueId: 'venue', expectedSnapshotHash: snapshotHash,
      component, actor }, client as never)
    expect(persisted).not.toBeNull()
    expect(JSON.stringify(persisted)).not.toContain(privateBody)
    expect(decodeSalesComponent(persisted!.capturedValue)).toMatchObject({
      retentionRecipe: { schema: 'torchiko.temporary-reply-preparation/1' },
    })
  })
  it('uses stable object-key identity while preserving array order and exact draft bytes', () => {
    expect(salesHash({ b: 2, a: 1 })).toBe(salesHash({ a: 1, b: 2 }))
    expect(salesHash(['a', 'b'])).not.toBe(salesHash(['b', 'a']))
    expect(salesHash('body')).not.toBe(salesHash('body '))
  })
  it('appends subject/body changes and idempotently reuses identical content', async () => {
    const h = harness()
    const first = await saveNativeSalesDraft(
      h.input('Subject', 'Normal message'),
      h.client as never,
    )
    expect(first).toMatchObject({
      version: 1,
      campaignId: null,
      memberId: null,
      contactId: 'candidate',
    })
    expect(first.groundingSnapshot).toMatchObject({
      SEND_AUTHORIZED: false,
      humanApproval: 'ABSENT',
    })
    const replay = await saveNativeSalesDraft(
      h.input('Subject', 'Normal message', first.id),
      h.client as never,
    )
    expect(replay.id).toBe(first.id)
    const second = await saveNativeSalesDraft(
      h.input('Changed subject', 'Normal message', first.id),
      h.client as never,
    )
    const third = await saveNativeSalesDraft(
      h.input('Changed subject', 'Changed normal message', second.id),
      h.client as never,
    )
    expect([first.version, second.version, third.version]).toEqual([1, 2, 3])
    expect(first.subject).toBe('Subject')
    expect(third.groundingSnapshot).toMatchObject({ previousDraftId: second.id })
  })
  it('rejects stale revision ids and changed snapshot identities', async () => {
    const h = harness()
    await saveNativeSalesDraft(h.input('Subject', 'Body'), h.client as never)
    await expect(
      saveNativeSalesDraft(h.input('Subject', 'New body'), h.client as never),
    ).rejects.toThrow(/STALE_DRAFT_REVISION/)
    await expect(
      saveNativeSalesDraft(
        { ...h.input('Subject', 'Body'), expectedSnapshotHash: 'c'.repeat(64) },
        h.client as never,
      ),
    ).rejects.toThrow(/STALE_NATIVE_SNAPSHOT/)
  })
  it('retains exact reference text as guidance, not authenticated authorship or approved language', () => {
    const text = 'SYNTHETIC diagnostic guidance: caf\u00e9 \u{1f33f}'
    const input = { label: 'Test only', sourceRef: 'synthetic:reference-v1', text, sha256: hash(text) }
    const value = bindNativeWritingReference(input, actor)
    expect(value.text).toBe(text)
    expect(value.sha256).toBe(hash(text))
    expect(value.authenticatedAuthorship).toBe(false)
    expect(value.approvedReusableLanguage).toBe(false)
    expect(value.SEND_AUTHORIZED).toBe(false)
    expect(() => bindNativeWritingReference({ ...input, text: text + 'changed' }, actor)).toThrow(/BYTES_MISMATCH/)
    expect(() => bindNativeWritingReference({ ...input, approved: true } as never, actor)).toThrow()
    const original = JSON.stringify(value)
    const replacement = { ...input, text: text + ' — revised', sha256: hash(text + ' — revised') }
    const changed = bindNativeWritingReference(replacement, actor)
    expect(changed.sourceRef).toBe(value.sourceRef)
    expect(changed.sha256).not.toBe(value.sha256)
    expect(JSON.stringify(value)).toBe(original)
    expect(salesHash(changed)).not.toBe(salesHash(value))
    expect(() => bindNativeWritingReference({ ...replacement, sha256: input.sha256 }, actor))
      .toThrow(/BYTES_MISMATCH/)
    // The owner supplies selected bytes. A sourceRef naming an unavailable file
    // cannot make the server fetch it or invent its content.
    expect(() => bindNativeWritingReference({ ...input, sourceRef: 'file:missing', text: '' }, actor))
      .toThrow(/BYTES_MISMATCH/)
  })
  it('does not rewrite manual provenance when a model returns identical message bytes', async () => {
    const h = harness()
    const manual = await saveNativeSalesDraft(h.input('NON-SALES check', 'Diagnostic body'), h.client as never)
    const original = JSON.stringify(manual)
    const generated = await saveNativeSalesDraft({
      ...h.input('NON-SALES check', 'Diagnostic body', manual.id),
      writerProvenance: { taskId: 'synthetic-task', resultHash: 'f'.repeat(64),
        generatedBy: { kind: 'model', identity: 'Synthetic test model' }, annotations: [] },
    }, h.client as never)
    expect(generated.id).not.toBe(manual.id)
    expect(generated.version).toBe(manual.version + 1)
    expect(generated.generatedByType).toBe('AGENT')
    expect(generated.generatedById).toBe('Synthetic test model')
    expect(JSON.stringify(manual)).toBe(original)
  })
  it('suppression wins before native draft creation', async () => {
    const h = harness()
    state.read.mockResolvedValue({ snapshotHash, suppression: { blocked: true } })
    await expect(
      saveNativeSalesDraft(h.input('Subject', 'Body'), h.client as never),
    ).rejects.toThrow(/suppression/)
    expect(h.tx.prospectOutreachDraft.create).not.toHaveBeenCalled()
  })
  it('a suppressed public route blocks even when it is not a native candidate email', async () => {
    const h = harness()
    h.tx.prospectContact.findMany.mockResolvedValue([{ id: 'different-org-native-suppression' }])
    await expect(
      saveNativeSalesDraft(h.input('Subject', 'Body'), h.client as never),
    ).rejects.toThrow(/public-route suppression/)
    expect(h.tx.prospectOutreachDraft.create).not.toHaveBeenCalled()
    expect(h.tx.prospectContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ normalizedEmail: 'candidate@example.invalid' }),
      }),
    )
    const form = await readNativeSalesRouteSuppression(
      { kind: 'contact_form', url: 'https://example.invalid/contact' },
      h.tx as never,
    )
    expect(form.blocked).toBe(false)
  })
  it('rejects fabricated send authorization and unbound draft hashes', async () => {
    const h = harness(),
      request = h.input('Subject', 'Body')
    await expect(
      saveNativeSalesDraft(
        { ...request, component: { ...request.component, SEND_AUTHORIZED: true } },
        h.client as never,
      ),
    ).rejects.toThrow(/no-send preparation/)
    await expect(
      saveNativeSalesDraft({ ...request, body: 'Different unchecked body' }, h.client as never),
    ).rejects.toThrow(/exact bytes/)
    expect(h.tx.prospectOutreachDraft.create).not.toHaveBeenCalled()
  })
  it('rejects agent authority before opening a transaction', async () => {
    const h = harness()
    await expect(
      saveNativeSalesDraft(
        { ...h.input('Subject', 'Body'), actor: { ...actor, type: 'AGENT' } as never },
        h.client as never,
      ),
    ).rejects.toThrow(/operator/)
    expect(h.client.$transaction).not.toHaveBeenCalled()
  })
  it.each(['doNotContact', 'suppressedAt', 'unsubscribedAt', 'complainedAt', 'lastHardBounceAt'])(
    'respects native contactability %s',
    (field) => {
      const candidate = {
        doNotContact: false,
        permissionState: 'UNKNOWN',
        suppressedAt: null,
        unsubscribedAt: null,
        complainedAt: null,
        lastHardBounceAt: null,
      }
      expect(nativeContactHeld(candidate)).toBe(false)
      expect(
        nativeContactHeld({ ...candidate, [field]: field === 'doNotContact' ? true : new Date() }),
      ).toBe(true)
      expect(nativeContactHeld({ ...candidate, permissionState: 'PROHIBITED' })).toBe(true)
    },
  )
})
