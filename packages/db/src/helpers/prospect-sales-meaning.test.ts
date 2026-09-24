import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  nativeMeaningBinding,
  recordNativeMeaningReview,
  type NativeMeaningDraft,
} from './prospect-sales-meaning'
import { decodeSalesComponent, encodeSalesComponent, salesHash } from './prospect-sales-snapshot'

const mock = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./prospect-sales-snapshot', async (original) => ({
  ...(await original<typeof import('./prospect-sales-snapshot')>()),
  readNativeSalesSnapshot: mock.read,
}))
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const nativeHash = 'a'.repeat(64)
const actor = { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'unit-authenticated-operator' } as const

function fixture() {
  const route = { kind: 'email', recipient: 'review@example.invalid', routing_id: 'route' }
  const component = {
    schema: 'torchiko.native-sales-components/1',
    SEND_AUTHORIZED: false,
    senderAvailable: false,
    nativeSnapshotHash: nativeHash,
    crosswalk: { nativeContactId: 'contact', routing: route },
    componentCodeHashes: { composer: 'c'.repeat(64), languageHead: 'd'.repeat(64) },
    preparation: {
      metadata: { preparation_id: 'composer-preparation' },
      fileSha256s: { source: 'e'.repeat(64), writer: 'f'.repeat(64) },
      writerContext: {
        WLT_packet_identity: 'wlt-exact',
        writer_context_sha256: 'writer-sha',
        research_snapshot: 'source-sha',
        approved_language_snapshot: { current_approved_count: 0, selected_entries: [] },
        relationship: {
          latest_message: { message_id: 'inbound', body: 'What would you propose?' },
        },
      },
    },
    correspondence: {
      projection: {
        thread_id: 'thread',
        reply_to_message_id: 'inbound',
        snapshot_sha256: 'thread-hash',
      },
      snapshot: { messages: [{ id: 'inbound', body: 'What would you propose?' }] },
    },
  }
  const draft: NativeMeaningDraft = {
    id: 'draft',
    preparationKey: 'series',
    organizationId: 'org',
    venueId: 'venue',
    contactId: 'contact',
    toEmail: route.recipient,
    version: 1,
    subject: 'A guide idea',
    textBody: 'Could a small guide be useful? 🔎',
    contentHash: '',
    groundingSnapshot: {
      schema: 'torchiko.native-sales-draft/1',
      preparationId: 'prep',
      nativeSnapshotHash: nativeHash,
      crosswalk: component.crosswalk,
      componentFileSha256s: component.preparation.fileSha256s,
      approvedLanguageSnapshot: component.preparation.writerContext.approved_language_snapshot,
      composerDraftSha256: digest('Subject: A guide idea\n\nCould a small guide be useful? 🔎\n'),
      WLTBodySha256: digest('Could a small guide be useful? 🔎'),
      SEND_AUTHORIZED: false,
    },
  }
  draft.contentHash = salesHash({
    series: draft.preparationKey,
    subject: draft.subject,
    body: draft.textBody,
    preparationId: 'prep',
    route,
    nativeSnapshotHash: nativeHash,
  })
  const bindingHash = nativeMeaningBinding(draft, component).bindingHash
  const submission = {
    bindingHash,
    draftId: draft.id,
    preparationId: 'prep',
    contentHash: draft.contentHash,
    reviewer: { kind: 'model', identity: 'Synthetic unit model assessment' },
    annotations: [],
    assessments: [],
    languageUses: [],
    answers: [],
    unsupportedClaims: [],
  }
  const check = {
    schema: 'torchiko.native-composer-meaning/1',
    bindingHash,
    draftId: draft.id,
    preparationId: 'prep',
    contentHash: draft.contentHash,
    composerDraftSha256: (draft.groundingSnapshot as Record<string, unknown>).composerDraftSha256,
    composerPreparationId: 'composer-preparation',
    submissionSha256: salesHash(submission),
    status: 'ASSESSED_NO_SEND',
    findings: [],
    unresolvedHolds: [],
    semanticCertification: false,
    humanApproval: 'ABSENT',
    SEND_AUTHORIZED: false,
  }
  const tx = {
    prospectContact: { findMany: vi.fn().mockResolvedValue([]) },
    prospectOutreachDraft: {
      findUnique: vi.fn().mockResolvedValue(draft),
      findFirst: vi.fn().mockResolvedValue(draft),
    },
    prospectSourceEvidence: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'prep',
        venueId: 'venue',
        sourceType: 'CRM_SALES_PREPARATION_V1',
        capturedValue: encodeSalesComponent(component),
      }),
      findFirst: vi.fn().mockResolvedValue({ id: 'prep' }),
    },
    prospectActivity: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => data),
    },
  }
  const client = { $transaction: vi.fn(async (fn) => fn(tx)) }
  const input = {
    venueId: 'venue',
    draftId: draft.id,
    contentHash: draft.contentHash,
    expectedSnapshotHash: nativeHash,
    expectedBindingHash: bindingHash,
    expectedMeaningReviewId: null as string | null,
    submission,
    component: { ...component, meaningCheck: check },
    actor,
  }
  return { draft, component, input, tx, client }
}

describe('native claim / meaning binding and immutable activity owner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.read.mockResolvedValue({ snapshotHash: nativeHash, suppression: { blocked: false } })
  })
  it('binds exact subject/body/recipient, native prep, code/library and inbound bytes', () => {
    const f = fixture(),
      bound = nativeMeaningBinding(f.draft, f.component)
    expect(bound.binding).toMatchObject({
      subject: f.draft.subject,
      body: f.draft.textBody,
      recipient: 'review@example.invalid',
      preparationId: 'prep',
      thread: { id: 'thread', replyToMessageId: 'inbound' },
      SEND_AUTHORIZED: false,
    })
    for (const key of ['subject', 'textBody', 'toEmail', 'contactId'] as const)
      expect(() =>
        nativeMeaningBinding({ ...f.draft, [key]: f.draft[key] + ' changed' }, f.component),
      ).toThrow(/binding|recipient/)
    for (const mutate of [
      (value: typeof f.component) => {
        value.componentCodeHashes.composer = 'new-code'
      },
      (value: typeof f.component) => {
        value.componentCodeHashes.languageHead = 'new-library'
      },
      (value: typeof f.component) => {
        value.correspondence.projection.thread_id = 'other-thread'
      },
      (value: typeof f.component) => {
        value.correspondence.snapshot.messages[0]!.body = 'Changed inbound evidence'
      },
      (value: typeof f.component) => {
        value.preparation.writerContext.WLT_packet_identity = 'new-wlt'
      },
    ]) {
      const changed = structuredClone(f.component)
      mutate(changed)
      expect(nativeMeaningBinding(f.draft, changed).bindingHash).not.toBe(bound.bindingHash)
    }
  })
  it('form-route URL bytes participate in a different binding without an email recipient', () => {
    const f = fixture()
    const route = {
      kind: 'contact_form',
      recipient: null,
      url: 'https://example.invalid/contact',
      routing_id: 'route-form',
    }
    const component = { ...f.component, crosswalk: { nativeContactId: null, routing: route } }
    const ground = { ...(f.draft.groundingSnapshot as object), crosswalk: component.crosswalk }
    const draft = {
      ...f.draft,
      contactId: null,
      toEmail: null,
      groundingSnapshot: ground,
      contentHash: salesHash({
        series: f.draft.preparationKey,
        subject: f.draft.subject,
        body: f.draft.textBody,
        preparationId: 'prep',
        route,
        nativeSnapshotHash: nativeHash,
      }),
    }
    const bound = nativeMeaningBinding(draft, component)
    expect(bound.binding).toMatchObject({
      recipient: null,
      route: { url: 'https://example.invalid/contact' },
    })
    expect(() =>
      nativeMeaningBinding(draft, {
        ...component,
        crosswalk: {
          ...component.crosswalk,
          routing: { ...route, url: 'https://example.invalid/other' },
        },
      }),
    ).toThrow(/source binding/)
  })
  it('persists exact immutable envelope in the existing protected activity schema, not a read review', async () => {
    const f = fixture()
    const result = await recordNativeMeaningReview(f.input, f.client as never)
    expect(f.client.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    )
    const evidence = result.evidence as Record<string, unknown>
    expect(evidence).toMatchObject({
      schema: 'torchiko.native-sales-review/1',
      reviewScope: 'CLAIM_MEANING_ASSESSMENT_NOT_APPROVAL',
      state: 'ASSESSED_NO_SEND',
      SEND_AUTHORIZED: false,
      humanApproval: 'ABSENT',
      semanticCertification: false,
    })
    const decoded = decodeSalesComponent(evidence.record)
    expect(decoded.submission).toEqual(f.input.submission)
    expect(decoded.binding).toEqual(nativeMeaningBinding(f.draft, f.component).binding)
  })
  it('records failed findings without silently clearing their holds', async () => {
    const f = fixture()
    Object.assign(f.input.component.meaningCheck, {
      status: 'BLOCKED',
      findings: [{ code: 'UNSUPPORTED_CLAIM', detail: 'Invented exhibit' }],
      unresolvedHolds: ['Invented exhibit'],
    })
    const result = await recordNativeMeaningReview(f.input, f.client as never)
    expect((result.evidence as Record<string, unknown>).state).toBe('BLOCKED')
  })
  it('rejects old native source, old draft, new preparation and concurrent review heads', async () => {
    const cases = [
      (f: ReturnType<typeof fixture>) => {
        f.input.expectedSnapshotHash = 'b'.repeat(64)
      },
      (f: ReturnType<typeof fixture>) => {
        f.tx.prospectOutreachDraft.findFirst.mockResolvedValue({ ...f.draft, id: 'new' })
      },
      (f: ReturnType<typeof fixture>) => {
        f.tx.prospectSourceEvidence.findFirst.mockResolvedValue({ id: 'new-prep' })
      },
      (f: ReturnType<typeof fixture>) => {
        f.tx.prospectActivity.findFirst.mockResolvedValue({ id: 'new-review' } as never)
      },
    ]
    for (const mutate of cases) {
      const f = fixture()
      mutate(f)
      await expect(recordNativeMeaningReview(f.input, f.client as never)).rejects.toThrow(
        /STALE_|CONCURRENT_/,
      )
      expect(f.tx.prospectActivity.create).not.toHaveBeenCalled()
    }
  })
  it('rejects changed components, payloads, send/certification flags and inconsistent passed status', async () => {
    const cases = [
      (f: ReturnType<typeof fixture>) => {
        f.input.component.componentCodeHashes = {
          ...f.component.componentCodeHashes,
          composer: 'changed',
        }
      },
      (f: ReturnType<typeof fixture>) => {
        f.input.expectedBindingHash = 'f'.repeat(64)
      },
      (f: ReturnType<typeof fixture>) => {
        f.input.submission.reviewer.identity = 'Different assessment author'
      },
      (f: ReturnType<typeof fixture>) => {
        f.input.component.meaningCheck.SEND_AUTHORIZED = true
      },
      (f: ReturnType<typeof fixture>) => {
        f.input.component.meaningCheck.semanticCertification = true
      },
      (f: ReturnType<typeof fixture>) => {
        f.input.component.meaningCheck.unresolvedHolds = ['Cannot be passed'] as never[]
      },
    ]
    for (const mutate of cases) {
      const f = fixture()
      mutate(f)
      await expect(recordNativeMeaningReview(f.input, f.client as never)).rejects.toThrow()
      expect(f.tx.prospectActivity.create).not.toHaveBeenCalled()
    }
  })
  it('identical retries are idempotent, but changed findings require the latest review identity', async () => {
    const f = fixture()
    const first = await recordNativeMeaningReview(f.input, f.client as never)
    f.tx.prospectActivity.findUnique.mockResolvedValue(first as never)
    const replay = await recordNativeMeaningReview(f.input, f.client as never)
    expect(replay.id).toBe(first.id)
    expect(f.tx.prospectActivity.create).toHaveBeenCalledTimes(1)
  })
  it('denies agent authority, fake human attribution, and native suppression', async () => {
    const f = fixture()
    await expect(
      recordNativeMeaningReview(
        { ...f.input, actor: { ...actor, type: 'AGENT' } as never },
        f.client as never,
      ),
    ).rejects.toThrow(/operator/)
    f.input.submission.reviewer = { kind: 'human', identity: 'Tom' }
    await expect(recordNativeMeaningReview(f.input, f.client as never)).rejects.toThrow(
      /authenticated operator/,
    )
    f.input.submission.reviewer = { kind: 'model', identity: 'A model' }
    mock.read.mockResolvedValue({ snapshotHash: nativeHash, suppression: { blocked: true } })
    await expect(recordNativeMeaningReview(f.input, f.client as never)).rejects.toThrow(
      /suppression/,
    )
    expect(f.tx.prospectActivity.create).not.toHaveBeenCalled()
  })
  it('maps a real serializable transaction conflict to explicit reload rather than retrying as another reviewer', async () => {
    const f = fixture()
    f.client.$transaction.mockRejectedValue({ code: 'P2034' })
    await expect(recordNativeMeaningReview(f.input, f.client as never)).rejects.toThrow(
      /CONCURRENT_MEANING_REVIEW/,
    )
    expect(f.client.$transaction).toHaveBeenCalledTimes(1)
  })
})
