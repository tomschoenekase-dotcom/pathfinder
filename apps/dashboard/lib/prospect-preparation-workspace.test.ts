import { describe, expect, it, vi } from 'vitest'
import type { NativeWriterResult } from '@pathfinder/api/prospect-writer-contract'
import type {
  SalesActionResponse,
  SalesWorkflowView,
} from '@pathfinder/api/prospect-sales-contract'
import {
  createProspectPreparationWorkspace,
  type PreparationWorkspaceTransport,
  type WorkspaceOrganization,
} from './prospect-preparation-workspace'

const h = 'a'.repeat(64)
const savedGuideSource = 'torchiko-writing-reference:v0.2-r001/TORCHIKO-WRITING-REFERENCE.md'
const binding = {
  venueId: 'venue-a',
  organizationId: 'org-a',
  preparationId: 'prep-a',
  nativeSnapshotHash: h,
  preparationHash: h,
  componentCodeHash: h,
  fileSetHash: h,
  selectionId: null,
  routeHash: h,
  routeKind: 'email' as const,
  recipient: 'fixture@example.invalid',
  formUrl: null,
  threadHash: h,
  libraryHash: h,
  wltHash: h,
  expectedDraftId: null,
  expectedVenueDraftId: null,
  expectedMeaningReviewId: null,
  expectedReadReviewId: null,
}
function view(
  org = 'org-a',
  venue = 'venue-a',
  overrides: Partial<SalesWorkflowView> = {},
): SalesWorkflowView {
  return {
    venueId: venue,
    organizationId: org,
    name: 'Synthetic venue',
    snapshotHash: h,
    sourceCount: 1,
    sourceState: 'SOURCE_PRESENT',
    contacts: [],
    gate: {
      decision: 'ENOUGH_EVIDENCE',
      canPrepare: true,
      questions: [],
      humanQuestions: [],
      notices: [],
    },
    routing: {
      kind: 'email',
      value: 'fixture@example.invalid',
      publicSnapshotStatus: 'SNAPSHOT_ONLY',
      nativeContactId: 'contact-a',
      readiness: 'VALID',
      permission: 'UNKNOWN',
    },
    suppression: { blocked: false, reasons: [] },
    outreachState: 'NO_DRAFT',
    correspondenceState: 'NO_THREAD',
    correspondence: null,
    threadCandidates: [],
    preparation: null,
    draft: null,
    revisions: [],
    blocker: null,
    SEND_AUTHORIZED: false,
    senderAvailable: false,
    writerTask: null,
    writerHold: null,
    ...overrides,
  }
}
function prepared(overrides: Partial<SalesWorkflowView> = {}): SalesWorkflowView {
  return view('org-a', 'venue-a', {
    preparation: {
      id: 'prep-a',
      stale: false,
      why: 'Synthetic',
      expectedDraftId: null,
      writerMarkdown: 'Synthetic source context',
      approvedCount: 0,
      selectedCount: 0,
      wltIdentity: 'WLT:a',
    },
    writerTask: {
      schema: 'torchiko.native-writer-task/1',
      taskId: `writer-task_${h}`,
      binding,
      notice: 'NO SEND',
      writerMarkdown: 'Synthetic context',
      writerContext: {},
      resultInstructions: 'Return one result',
      SEND_AUTHORIZED: false,
    },
    ...overrides,
  })
}
function result(): NativeWriterResult {
  return {
    schema: 'torchiko.native-writer-result/1',
    taskId: `writer-task_${h}`,
    binding,
    generatedBy: { kind: 'model', identity: 'Synthetic model' },
    subject: 'Hello',
    body: 'Hi, 🌿',
    annotations: [
      {
        annotation_id: 's',
        section: 'subject',
        start: 0,
        end: 5,
        quote: 'Hello',
        category: 'NONFACTUAL',
        claim_ids: [],
        reason: 'Synthetic test greeting',
        answers: [],
      },
      {
        annotation_id: 'b',
        section: 'body',
        start: 0,
        end: 5,
        quote: 'Hi, 🌿',
        category: 'NONFACTUAL',
        claim_ids: [],
        reason: 'Synthetic test greeting',
        answers: [],
      },
    ],
    languageUses: [],
    assessment: null,
  }
}
function fixture(
  input: {
    organizations?: Record<string, WorkspaceOrganization | null>
    views?: Record<string, SalesWorkflowView>
    action?: (
      action: Parameters<PreparationWorkspaceTransport['act']>[0],
    ) => Promise<SalesActionResponse>
  } = {},
) {
  const organizations = input.organizations ?? {
    'org-a': {
      id: 'org-a',
      canonicalName: 'Synthetic A',
      venues: [{ id: 'venue-a', name: 'Fixture A', archivedAt: null }],
    },
  }
  const views = input.views ?? { 'venue-a': view() }
  const storageData = new Map<string, string>()
  const storage = {
    getItem: (key: string) => storageData.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageData.set(key, value)
    },
  }
  const transport: PreparationWorkspaceTransport = {
    readOrganization: vi.fn(async (id) => organizations[id] ?? null),
    load: vi.fn(async (id) => {
      const current = views[id]
      if (!current) throw new Error('No native workflow')
      return current
    }),
    act: vi.fn(
      input.action ??
        (async (action) => {
          if (action.action !== 'prepare') throw new Error('Unexpected action')
          const guide =
            'savedWritingGuide' in action.input && action.input.savedWritingGuide
              ? {
                  label: 'Saved guide',
                  sourceRef: savedGuideSource,
                  text: 'Synthetic exact guide',
                  sha256: action.input.expectedWritingGuideSha256,
                }
              : action.input.writingReference
          const next = prepared({
            preparation: {
              ...prepared().preparation!,
              ...(guide ? { writingReference: guide } : {}),
            },
          })
          views[action.input.venueId] = next
          return next
        }),
    ),
  }
  return { organizations, views, storage, storageData, transport }
}

describe('selected native preparation workspace', () => {
  it('shows successful peers while one selected organization read is still pending', async () => {
    const f = fixture({
      organizations: {
        'org-a': { id: 'org-a', canonicalName: 'A', venues: [{ id: 'venue-a', name: 'A' }] },
        'org-b': { id: 'org-b', canonicalName: 'B', venues: [{ id: 'venue-b', name: 'B' }] },
      },
      views: { 'venue-a': view(), 'venue-b': view('org-b', 'venue-b') },
    })
    let finish!: (value: WorkspaceOrganization | null) => void
    vi.mocked(f.transport.readOrganization).mockImplementation(async (id) =>
      id === 'org-a'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : (f.organizations[id] ?? null),
    )
    const work = createProspectPreparationWorkspace({ transport: f.transport, storage: f.storage })
    const selection = work.selectOrganizations(['org-a', 'org-b'])
    await vi.waitFor(() => expect(work.snapshot().items[1]?.status).toBe('READABLE'))
    expect(work.snapshot().counts.LOADING).toBe(1)
    expect(work.snapshot().counts.READABLE).toBe(1)
    finish(null)
    await selection
    expect(work.snapshot().counts.MISSING_ORGANIZATION).toBe(1)
    expect(work.snapshot().counts.READABLE).toBe(1)
  })

  it('holds venue and selection changes while exact reference bytes are hashing', async () => {
    const f = fixture({
      organizations: {
        'org-a': {
          id: 'org-a',
          canonicalName: 'A',
          venues: [
            { id: 'venue-a', name: 'A1' },
            { id: 'venue-b', name: 'A2' },
          ],
        },
      },
      views: { 'venue-a': view(), 'venue-b': view('org-a', 'venue-b') },
    })
    const work = createProspectPreparationWorkspace({ transport: f.transport, storage: f.storage })
    await work.selectOrganizations(['org-a'])
    await work.chooseVenue('org-a', 'venue-a')
    let finish!: (value: ArrayBuffer) => void
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    try {
      const writing = work.setWritingReference('org-a', {
        label: 'Explicit synthetic reference',
        sourceRef: 'synthetic:reference',
        text: 'Synthetic reference bytes',
        sha256: h,
      })
      await expect(work.chooseVenue('org-a', 'venue-b')).rejects.toThrow('action in progress')
      await expect(work.selectOrganizations([])).rejects.toThrow('Wait for the current preparation')
      finish(new Uint8Array(32).fill(170).buffer)
      await writing
      expect(work.snapshot().items[0]).toMatchObject({
        venueId: 'venue-a',
        writingReference: { sha256: h },
      })
    } finally {
      digest.mockRestore()
    }
  })

  it('holds deselection until the current source-bound task export finishes', async () => {
    const f = fixture({ views: { 'venue-a': prepared() } })
    const work = createProspectPreparationWorkspace({ transport: f.transport, storage: f.storage })
    await work.selectOrganizations(['org-a'])
    let finish!: (value: WorkspaceOrganization | null) => void
    vi.mocked(f.transport.readOrganization).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const exporting = work.currentWriterTask('org-a')
    await expect(work.selectOrganizations([])).rejects.toThrow('Wait for the current preparation')
    finish(f.organizations['org-a']!)
    expect((await exporting).binding.venueId).toBe('venue-a')
    await work.selectOrganizations([])
    await expect(work.currentWriterTask('org-a')).rejects.toThrow(
      'not in this explicitly selected workspace',
    )
  })

  it.each(['older success', 'older failure'])(
    'keeps the newer native view after an %s arrives late',
    async (outcome) => {
      const f = fixture()
      const work = createProspectPreparationWorkspace({
        transport: f.transport,
        storage: f.storage,
      })
      await work.selectOrganizations(['org-a'])
      let finish!: (value: SalesWorkflowView) => void
      let fail!: (reason: Error) => void
      vi.mocked(f.transport.load).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = resolve
            fail = reject
          }),
      )
      const older = work.refresh('org-a')
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      f.views['venue-a'] = view('org-a', 'venue-a', { snapshotHash: 'b'.repeat(64) })
      await work.refresh('org-a')
      if (outcome === 'older success') finish(view())
      else fail(new Error('Older unavailable response'))
      await older
      expect(work.snapshot().items[0]).toMatchObject({
        status: 'READABLE',
        view: { snapshotHash: 'b'.repeat(64) },
      })
    },
  )

  it('does not resurrect a removed selection after its earlier native read completes', async () => {
    const f = fixture()
    const work = createProspectPreparationWorkspace({ transport: f.transport, storage: f.storage })
    let finish!: (value: WorkspaceOrganization | null) => void
    vi.mocked(f.transport.readOrganization).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const older = work.selectOrganizations(['org-a', 'org-b'])
    await work.selectOrganizations([])
    finish(f.organizations['org-a']!)
    await older
    expect(work.snapshot().items).toEqual([])
    expect(f.transport.load).not.toHaveBeenCalled()
    expect(JSON.stringify([...f.storageData.values()])).not.toContain('org-a')
  })

  it('fences duplicate actions and guide changes while the authoritative preflight read is pending', async () => {
    const f = fixture()
    const work = createProspectPreparationWorkspace({ transport: f.transport, storage: f.storage })
    await work.selectOrganizations(['org-a'])
    let finishRead!: (value: WorkspaceOrganization) => void
    vi.mocked(f.transport.readOrganization).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        }),
    )
    const first = work.prepare('org-a')
    await expect(work.prepare('org-a')).rejects.toThrow('action in progress')
    expect(() => work.setGuide('org-a', { sourceRef: savedGuideSource, sha256: h })).toThrow(
      'action in progress',
    )
    await expect(work.selectOrganizations([])).rejects.toThrow('Wait for the current preparation')
    finishRead(f.organizations['org-a']!)
    expect((await first).status).toBe('PREPARED')
    expect(f.transport.act).toHaveBeenCalledTimes(1)
  })

  it('resolves only exact native venues and keeps partial success when peers are held', async () => {
    const f = fixture({
      organizations: {
        'org-a': { id: 'org-a', canonicalName: 'A', venues: [{ id: 'venue-a', name: 'A' }] },
        'org-b': { id: 'org-b', canonicalName: 'B', venues: [] },
        'org-c': {
          id: 'org-c',
          canonicalName: 'C',
          venues: [
            { id: 'venue-c1', name: 'C1' },
            { id: 'venue-c2', name: 'C2' },
          ],
        },
        'org-d': { id: 'org-d', canonicalName: 'D', venues: [{ id: 'venue-d', name: 'D' }] },
        'org-e': { id: 'org-e', canonicalName: 'E', venues: [{ id: 'venue-e', name: 'E' }] },
      },
      views: {
        'venue-a': view(),
        'venue-c1': view('org-c', 'venue-c1'),
        'venue-c2': view('org-c', 'venue-c2'),
        'venue-d': view('org-d', 'venue-d', {
          suppression: { blocked: true, reasons: ['Explicit synthetic hold'] },
        }),
        'venue-e': view('org-e', 'venue-e', { routing: null }),
      },
    })
    const work = createProspectPreparationWorkspace({ transport: f.transport, storage: f.storage })
    const before = await work.selectOrganizations(['org-a', 'org-b', 'org-c', 'org-d', 'org-e'])
    expect(before.items.map((item) => item.status)).toEqual([
      'READABLE',
      'MISSING_VENUE',
      'AMBIGUOUS_VENUE',
      'SUPPRESSED',
      'MISSING_ROUTE',
    ])
    expect(before.counts.READABLE).toBe(1)
    expect(f.transport.act).not.toHaveBeenCalled()
    await expect(work.chooseVenue('org-c', 'venue-a')).rejects.toThrow('current native choices')
    expect((await work.chooseVenue('org-c', 'venue-c2')).venueId).toBe('venue-c2')
    const after = await work.prepare('org-a')
    expect(after.status).toBe('PREPARED')
    expect(work.snapshot().items.find((item) => item.organizationId === 'org-d')?.status).toBe(
      'SUPPRESSED',
    )
    expect(work.snapshot().counts.PREPARED).toBe(1)
    expect(f.transport.act).toHaveBeenCalledTimes(1)
    await expect(
      work.selectOrganizations(Array.from({ length: 11 }, (_, n) => `org-${n}`)),
    ).rejects.toThrow('at most ten')
  })

  it('holds changed guide, new reply, and ambiguous thread without replacing source context', async () => {
    const f = fixture()
    const work = createProspectPreparationWorkspace({ transport: f.transport, storage: f.storage })
    await work.selectOrganizations(['org-a'])
    const guide = { sourceRef: savedGuideSource, sha256: h }
    expect(work.setGuide('org-a', guide).status).toBe('READABLE')
    await work.prepare('org-a')
    expect(f.transport.act).toHaveBeenCalledWith({
      action: 'prepare',
      input: expect.objectContaining({
        venueId: 'venue-a',
        savedWritingGuide: 'torchiko-v0.2',
        expectedWritingGuideSha256: h,
      }),
    })
    expect(work.snapshot().items[0]?.status).toBe('PREPARED')
    expect(work.setGuide('org-a', { ...guide, sha256: 'b'.repeat(64) }).status).toBe('STALE')
    f.views['venue-a'] = prepared({
      snapshotHash: 'c'.repeat(64),
      preparation: { ...prepared().preparation!, stale: true },
      writerTask: null,
    })
    expect((await work.refresh('org-a')).status).toBe('STALE')
    f.views['venue-a'] = view('org-a', 'venue-a', {
      threadCandidates: [
        { id: 'thread-1', messageCount: 2, updatedAt: '', sourceComplete: true, sourceIssues: [] },
        {
          id: 'thread-2',
          messageCount: 1,
          updatedAt: '',
          sourceComplete: false,
          sourceIssues: ['Body absent'],
        },
      ],
    })
    work.setGuide('org-a', null)
    expect((await work.refresh('org-a')).status).toBe('AMBIGUOUS_THREAD')
    expect(work.chooseThread('org-a', 'thread-2').status).toBe('REQUIRES_RESEARCH')
    await expect(
      work.prepare('org-a', { selectedThreadId: 'thread-2', answerText: 'Synthetic answer' }),
    ).rejects.toThrow('source-incomplete')
  })

  it('recovers an uncertain prepare from authoritative readback without automatic retry', async () => {
    const f = fixture({
      action: async () => {
        throw new Error('response lost')
      },
    })
    const work = createProspectPreparationWorkspace({ transport: f.transport, storage: f.storage })
    await work.selectOrganizations(['org-a'])
    expect((await work.prepare('org-a')).status).toBe('PREPARE_UNCERTAIN')
    expect(f.transport.act).toHaveBeenCalledTimes(1)
    f.views['venue-a'] = prepared()
    expect((await work.refresh('org-a')).status).toBe('PREPARED')
    expect(f.transport.act).toHaveBeenCalledTimes(1)
  })

  it('unlocks a known precommit stale-guide rejection so the new exact hash can be selected', async () => {
    const stale = Object.assign(
      new Error('STALE_SELECTED_WRITING_GUIDE: reload the guide descriptor before preparing'),
      { data: { code: 'CONFLICT' } },
    )
    const f = fixture({
      action: vi
        .fn()
        .mockRejectedValueOnce(stale)
        .mockResolvedValueOnce(
          prepared({
            preparation: {
              ...prepared().preparation!,
              writingReference: {
                label: 'Saved guide',
                sourceRef: savedGuideSource,
                text: 'Current synthetic guide',
                sha256: 'b'.repeat(64),
              },
            },
          }),
        ),
    })
    const work = createProspectPreparationWorkspace({ transport: f.transport, storage: f.storage })
    await work.selectOrganizations(['org-a'])
    work.setGuide('org-a', { sourceRef: savedGuideSource, sha256: h })
    const rejected = await work.prepare('org-a')
    expect(rejected.status).toBe('STALE')
    expect(rejected.reason).toContain('STALE_SELECTED_WRITING_GUIDE')
    expect(
      work.setGuide('org-a', { sourceRef: savedGuideSource, sha256: 'b'.repeat(64) }).status,
    ).toBe('READABLE')
    const retried = await work.prepare('org-a')
    expect(retried.status).toBe('PREPARED')
    expect(f.transport.act).toHaveBeenNthCalledWith(2, {
      action: 'prepare',
      input: expect.objectContaining({ expectedWritingGuideSha256: 'b'.repeat(64) }),
    })
    f.views['venue-a'] = prepared({
      writerTask: null,
      writerHold: 'STALE_SELECTED_WRITING_GUIDE: prepare a new source-bound context',
    })
    expect((await work.refresh('org-a')).status).toBe('STALE')
  })

  it('releases only a named precommit import conflict and keeps an unknown response exact-retry only', async () => {
    const stale = Object.assign(new Error('STALE_NATIVE_SNAPSHOT: reload before this action'), {
      data: { code: 'CONFLICT' },
    })
    const f = fixture({
      views: { 'venue-a': prepared() },
      action: vi.fn().mockRejectedValueOnce(stale).mockRejectedValueOnce(new Error('gateway 500')),
    })
    const work = createProspectPreparationWorkspace({ transport: f.transport, storage: f.storage })
    await work.selectOrganizations(['org-a'])
    const rejected = await work.importWriterResult('org-a', result())
    expect(rejected.status).toBe('STALE')
    expect(rejected.pendingImport).toBeNull()
    expect(work.setGuide('org-a', { sourceRef: savedGuideSource, sha256: h }).guide).toEqual({
      sourceRef: savedGuideSource,
      sha256: h,
    })
    work.setGuide('org-a', null)
    // Same current task in this fixture; a new explicit result attempt may run.
    const unknown = await work.importWriterResult('org-a', result())
    expect(unknown.status).toBe('IMPORT_UNCERTAIN')
    expect(unknown.pendingImport?.taskId).toBe(result().taskId)
    expect(() =>
      work.setGuide('org-a', { sourceRef: savedGuideSource, sha256: 'b'.repeat(64) }),
    ).toThrow('Recover the exact pending action')
  })

  it('reopens refs only and recovers a lost import by explicitly replaying the same result', async () => {
    let committed = false
    const receipt = { id: 'writer-import-1', draftId: 'draft-1', replayed: false }
    const f = fixture({
      views: { 'venue-a': prepared() },
      action: async (action) => {
        if (action.action !== 'importWriterResult') throw new Error('Unexpected action')
        if (!committed) {
          committed = true
          throw new Error('Response lost after commit')
        }
        return {
          schema: 'torchiko.native-writer-import-receipt-only/1' as const,
          venueId: 'venue-a',
          originalSnapshotHash: h,
          writerImportReceipt: { ...receipt, meaningReviewId: null, replayed: true },
          currentViewAvailable: false as const,
          currentViewFailure: 'READ_FAILED' as const,
          SEND_AUTHORIZED: false as const,
          senderAvailable: false as const,
        }
      },
    })
    const first = createProspectPreparationWorkspace({ transport: f.transport, storage: f.storage })
    await first.selectOrganizations(['org-a'])
    expect((await first.importWriterResult('org-a', result())).status).toBe('IMPORT_UNCERTAIN')
    expect(f.transport.act).toHaveBeenCalledTimes(1)
    const saved = JSON.stringify([...f.storageData.values()])
    expect(saved).not.toContain('Hi, 🌿')
    expect(saved).not.toContain('Synthetic model')
    const reopened = createProspectPreparationWorkspace({
      transport: f.transport,
      storage: f.storage,
    })
    expect((await reopened.reopen()).items[0]?.status).toBe('IMPORT_UNCERTAIN')
    await expect(
      reopened.importWriterResult('org-a', {
        ...result(),
        generatedBy: { kind: 'model', identity: 'Different synthetic model' },
      }),
    ).rejects.toThrow('same exact result file')
    expect(f.transport.act).toHaveBeenCalledTimes(1)
    const after = await reopened.importWriterResult('org-a', result())
    expect(after.status).toBe('RESULT_RETAINED')
    expect(after.receipt).toMatchObject({
      id: receipt.id,
      draftId: receipt.draftId,
      replayed: true,
    })
    expect(f.transport.act).toHaveBeenCalledTimes(2)
  })
})
