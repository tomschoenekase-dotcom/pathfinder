import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  admitNativeSourceSelection,
  NATIVE_CAPTURE_SOURCE,
  NATIVE_SELECTION_SOURCE,
  stageNativeSourceCapture,
} from './prospect-source-admission'
import { encodeSalesComponent, salesHash } from './prospect-sales-snapshot'
const state = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./prospect-sales-snapshot', async (original) => ({
  ...(await original<typeof import('./prospect-sales-snapshot')>()),
  readNativeSalesSnapshot: state.read,
}))
const actor = {
  type: 'SYSTEM',
  role: 'PLATFORM_ADMIN',
  id: 'synthetic:crm-meaning:evidence-unit',
} as const
const snapshotHash = 'a'.repeat(64)
function harness() {
  const records = new Map<string, Record<string, unknown>>()
  const tx = {
    prospectSourceEvidence: {
      findUnique: vi.fn(async ({ where }) => records.get(where.id) ?? null),
      findFirst: vi.fn(
        async () =>
          [...records.values()].filter((r) => r.sourceType === NATIVE_SELECTION_SOURCE).at(-1) ??
          null,
      ),
      create: vi.fn(async ({ data }) => {
        records.set(data.id, data)
        return data
      }),
    },
    prospectContact: { findMany: vi.fn().mockResolvedValue([]) },
    prospectActivity: { create: vi.fn().mockResolvedValue({ id: 'activity' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit' }) },
  }
  const client = { $transaction: vi.fn(async (fn) => fn(tx)) }
  const capture = {
    identity: { venueId: 'venue', organizationId: 'org' },
    pages: [{ url: 'https://example.invalid/', observedAt: '2026-09-20T00:00:00Z' }],
    provenance: {
      producer: 'Explicit synthetic source-writer unit fixture; never persisted to real CRM',
    },
    SEND_AUTHORIZED: false,
  }
  const captureHash = salesHash(capture),
    captureId = 'native-capture_' + captureHash.slice(0, 40)
  const base = { nativeSnapshotHash: snapshotHash, SEND_AUTHORIZED: false, senderAvailable: false }
  const stage = {
    venueId: 'venue',
    expectedSnapshotHash: snapshotHash,
    capture,
    actor,
    component: { ...base, captureCheck: { captureId, captureHash, SEND_AUTHORIZED: false } },
  }
  const select = (previous: string | null = null) => {
    const selection = {
      claimIds: ['identity'],
      routeClaimId: 'email',
      purpose: 'Bounded synthetic source unit check',
      hypothesis: 'Propose a guide discussion, not a fact.',
    }
    const record = { captureId, selection, previousSelectionId: previous, SEND_AUTHORIZED: false }
    return {
      venueId: 'venue',
      expectedSnapshotHash: snapshotHash,
      expectedSelectionId: previous,
      captureId,
      selection,
      actor,
      component: {
        ...base,
        admissionCheck: { selectionHash: salesHash(record), SEND_AUTHORIZED: false },
        crosswalk: { routing: { kind: 'email', recipient: 'venue@example.invalid' } },
        gate: { decision: 'ENOUGH_EVIDENCE' },
      },
    }
  }
  return { tx, client, records, stage, select, captureId }
}
describe('native evidence admission uses existing append-only source and strict audit owners', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('TORCHIKO_LOCAL_CRM_SALES_ENABLED', '1')
    vi.stubEnv(
      'DATABASE_URL',
      'postgresql://fixture@127.0.0.1:58617/pathfinder_disposable_crm_research_20260919',
    )
    vi.stubEnv('DIRECT_DATABASE_URL', '')
    vi.stubEnv('APP_ENV', 'local')
    state.read.mockResolvedValue({
      snapshotHash,
      venue: { id: 'venue' },
      organization: { id: 'org' },
      suppression: { blocked: false },
    })
  })
  afterEach(() => vi.unstubAllEnvs())
  it('appends exact capture once and replays without refreshing dates or contact state', async () => {
    const h = harness()
    const first = await stageNativeSourceCapture(h.stage, h.client as never)
    const replay = await stageNativeSourceCapture(h.stage, h.client as never)
    expect(first.id).toBe(replay.id)
    expect(first.sourceType).toBe(NATIVE_CAPTURE_SOURCE)
    expect(first.researchedAt).toEqual(new Date('2026-09-20T00:00:00Z'))
    expect(h.tx.prospectSourceEvidence.create).toHaveBeenCalledTimes(1)
    expect(h.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: 'SYSTEM',
        action: 'prospect.source_capture.recorded_no_send',
      }),
    })
  })
  it('rejects changed capture bytes under an old checker receipt', async () => {
    const h = harness()
    await expect(
      stageNativeSourceCapture(
        { ...h.stage, capture: { ...h.stage.capture, invented: 'new claim' } },
        h.client as never,
      ),
    ).rejects.toThrow(/bound/)
    expect(h.client.$transaction).not.toHaveBeenCalled()
  })
  it('binds native venue and source identity instead of sharing a domain', async () => {
    const h = harness()
    state.read.mockResolvedValue({
      snapshotHash,
      venue: { id: 'other' },
      organization: { id: 'org' },
      suppression: { blocked: false },
    })
    await expect(stageNativeSourceCapture(h.stage, h.client as never)).rejects.toThrow(
      /WRONG_NATIVE/,
    )
    expect(h.tx.prospectSourceEvidence.create).not.toHaveBeenCalled()
  })
  it('selection is an audited no-send revision; exact replay and repeated current selection are zero-write', async () => {
    const h = harness()
    await stageNativeSourceCapture(h.stage, h.client as never)
    const first = await admitNativeSourceSelection(h.select(), h.client as never)
    const replay = await admitNativeSourceSelection(h.select(), h.client as never)
    const current = await admitNativeSourceSelection(h.select(first.id), h.client as never)
    expect([first.id, replay.id, current.id]).toEqual([first.id, first.id, first.id])
    expect(h.tx.prospectSourceEvidence.create).toHaveBeenCalledTimes(2)
    expect(h.tx.prospectActivity.create).toHaveBeenCalledTimes(1)
    expect(h.tx.auditLog.create).toHaveBeenCalledTimes(2)
    expect(h.tx.prospectActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        evidence: expect.objectContaining({
          humanApproval: 'ABSENT',
          SEND_AUTHORIZED: false,
          recordedByType: 'SYSTEM',
        }),
      }),
    })
  })
  it('rejects stale expected evidence head and source snapshot', async () => {
    const h = harness()
    await stageNativeSourceCapture(h.stage, h.client as never)
    await expect(
      admitNativeSourceSelection(h.select('not-current'), h.client as never),
    ).rejects.toThrow(/CONCURRENT_EVIDENCE/)
    await expect(
      admitNativeSourceSelection(
        { ...h.select(), expectedSnapshotHash: 'b'.repeat(64) },
        h.client as never,
      ),
    ).rejects.toThrow(/STALE_NATIVE/)
  })
  it('refuses a capture from another native venue even with a matching checker hash', async () => {
    const h = harness()
    h.records.set(h.captureId, {
      id: h.captureId,
      venueId: 'other',
      sourceType: NATIVE_CAPTURE_SOURCE,
      capturedValue: encodeSalesComponent({}),
    })
    await expect(admitNativeSourceSelection(h.select(), h.client as never)).rejects.toThrow(
      /exact native prospect/,
    )
  })
  it('suppression wins and audit failures do not get swallowed', async () => {
    const h = harness()
    await stageNativeSourceCapture(h.stage, h.client as never)
    h.tx.prospectContact.findMany.mockResolvedValue([{ id: 'held' }])
    await expect(admitNativeSourceSelection(h.select(), h.client as never)).rejects.toThrow(
      /suppression/,
    )
    h.tx.prospectContact.findMany.mockResolvedValue([])
    h.tx.auditLog.create.mockRejectedValue(new Error('audit unavailable'))
    await expect(admitNativeSourceSelection(h.select(), h.client as never)).rejects.toThrow(
      /audit unavailable/,
    )
  })
  it('no production, arbitrary system, agent, or sending authority is admitted', async () => {
    const h = harness()
    await expect(
      stageNativeSourceCapture(
        { ...h.stage, actor: { ...actor, type: 'AGENT' } as never },
        h.client as never,
      ),
    ).rejects.toThrow(/operator/)
    vi.stubEnv('NODE_ENV', 'production')
    await expect(stageNativeSourceCapture(h.stage, h.client as never)).rejects.toThrow()
    expect(h.client.$transaction).not.toHaveBeenCalled()
  })
})
