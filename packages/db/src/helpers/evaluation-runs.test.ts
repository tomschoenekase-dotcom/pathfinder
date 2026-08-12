import type { EvalRun } from '@prisma/client'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createOrReplayEvaluationRun,
  evaluationRunIdentityHash,
  EvaluationRunIdentityError,
  EvaluationRunReplayConflictError,
  isVerifiedEvaluationRunIdentity,
  type EvaluationRunIdentity,
} from './evaluation-runs'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const RUN_ID = '11111111-1111-4111-8111-111111111111'

const identity = (overrides: Partial<EvaluationRunIdentity> = {}): EvaluationRunIdentity => ({
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  idempotencyKey: 'eval-command-1',
  caseManifest: [{ caseId: '22222222-2222-4222-8222-222222222222', revision: 1, caseHash: HASH_A }],
  promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
  promptContractHash: GUEST_CHAT_PROMPT_CONTRACT_HASH,
  packageSnapshotRef: 'package_1',
  packageSnapshotHash: HASH_B,
  contentSnapshotVersion: 42n,
  contentSnapshotHash: HASH_C,
  modelProvider: 'synthetic',
  modelName: 'deterministic-fixture',
  modelSnapshot: { temperature: 0, nested: { b: 2, a: 1 } },
  runConfigSnapshot: { thresholds: { casePassRate: 1 } },
  declaredBudgetCeilingE8Usd: 0n,
  createdBy: 'operator_1',
  triggerType: 'MANUAL',
  ...overrides,
})

function mockClient() {
  return {
    evalRun: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  }
}

function storedRun(data: Record<string, unknown>): EvalRun {
  return { ...data, createdAt: new Date('2026-08-08T00:00:00.000Z') } as EvalRun
}

describe('evaluation run identity', () => {
  beforeEach(() => vi.clearAllMocks())

  it('preserves the exact legacy v2 identity hash and omits additive discriminator fields', async () => {
    expect(evaluationRunIdentityHash(identity())).toBe(
      '9565e9f3b5df0c5a962454d70e27f5468fc7540e23c202761371f67d5958b880',
    )
    const client = mockClient()
    client.evalRun.findFirst.mockResolvedValueOnce(null)
    client.evalRun.create.mockImplementationOnce(async ({ data }) => storedRun(data))
    const { run } = await createOrReplayEvaluationRun({
      db: client as never,
      runId: RUN_ID,
      identity: identity(),
    })
    expect(run.identitySnapshot).toMatchObject({ version: 'pathfinder-eval-run-identity-v2' })
    expect(run.identitySnapshot).not.toHaveProperty('contentSnapshotKind')
    expect(run.identitySnapshot).not.toHaveProperty('contentSnapshotRef')
    expect(run).toMatchObject({
      contentSnapshotKind: 'LEGACY_VENUE_CONTENT_V1',
      contentSnapshotRef: null,
    })
  })

  it('uses a distinct v3 hash domain for an exact native release snapshot', async () => {
    const native = identity({
      contentSnapshotKind: 'NATIVE_CORE_V1',
      contentSnapshotRef: RUN_ID,
      packageSnapshotRef: `native-core-v1:${RUN_ID}`,
    } as Partial<EvaluationRunIdentity>)
    expect(evaluationRunIdentityHash(native)).not.toBe(evaluationRunIdentityHash(identity()))
    const client = mockClient()
    client.evalRun.findFirst.mockResolvedValueOnce(null)
    client.evalRun.create.mockImplementationOnce(async ({ data }) => storedRun(data))
    const { run } = await createOrReplayEvaluationRun({
      db: client as never,
      runId: RUN_ID,
      identity: native,
    })
    expect(run.identitySnapshot).toMatchObject({
      version: 'pathfinder-eval-run-identity-v3',
      contentSnapshotKind: 'NATIVE_CORE_V1',
      contentSnapshotRef: RUN_ID,
    })
  })

  it('is canonical across JSON key order and Unicode NFC', () => {
    const first = evaluationRunIdentityHash(identity())
    const reordered = evaluationRunIdentityHash(
      identity({
        modelSnapshot: { nested: { a: 1, b: 2 }, temperature: 0 },
        modelName: 'de\u0301terministic-fixture',
      }),
    )
    const composed = evaluationRunIdentityHash(identity({ modelName: 'déterministic-fixture' }))

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(reordered).toBe(composed)
    expect(
      evaluationRunIdentityHash(
        identity({
          caseManifest: [
            {
              caseId: '22222222-2222-4222-8222-222222222222',
              revision: 1,
              caseHash: 'e'.repeat(64),
            },
          ],
        }),
      ),
    ).not.toBe(first)
  })

  it('creates once and replays only the exact stored identity', async () => {
    const client = mockClient()
    client.evalRun.findFirst.mockResolvedValueOnce(null)
    client.evalRun.create.mockImplementationOnce(async ({ data }) => storedRun(data))

    const created = await createOrReplayEvaluationRun({
      db: client as never,
      runId: RUN_ID,
      identity: identity(),
    })
    expect(created.replayed).toBe(false)
    expect(created.run).toMatchObject({
      id: RUN_ID,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      declaredBudgetCeilingE8Usd: 0n,
    })
    expect(created.run.modelSnapshotHash).toMatch(/^[0-9a-f]{64}$/)

    client.evalRun.findFirst.mockResolvedValueOnce(created.run)
    await expect(
      createOrReplayEvaluationRun({ db: client as never, runId: RUN_ID, identity: identity() }),
    ).resolves.toEqual({ run: created.run, replayed: true })
    expect(client.evalRun.create).toHaveBeenCalledOnce()
  })

  it('verifies a stored identity and rejects any duplicated-column drift', async () => {
    const client = mockClient()
    client.evalRun.findFirst.mockResolvedValueOnce(null)
    client.evalRun.create.mockImplementationOnce(async ({ data }) => storedRun(data))
    const { run } = await createOrReplayEvaluationRun({
      db: client as never,
      runId: RUN_ID,
      identity: identity(),
    })
    expect(isVerifiedEvaluationRunIdentity(run)).toBe(true)
    expect(isVerifiedEvaluationRunIdentity({ ...run, modelName: 'changed' })).toBe(false)
    expect(
      isVerifiedEvaluationRunIdentity({ ...run, identitySnapshot: { malformed: 1n } as never }),
    ).toBe(false)
  })

  it('rejects a changed identity behind the same idempotency key', async () => {
    const client = mockClient()
    client.evalRun.findFirst.mockResolvedValueOnce(
      storedRun({
        id: RUN_ID,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        idempotencyKey: 'eval-command-1',
        identityHash: '0'.repeat(64),
        identitySnapshot: {},
      }),
    )

    await expect(
      createOrReplayEvaluationRun({
        db: client as never,
        runId: RUN_ID,
        identity: identity({ declaredBudgetCeilingE8Usd: 1n }),
      }),
    ).rejects.toBeInstanceOf(EvaluationRunReplayConflictError)
    expect(client.evalRun.create).not.toHaveBeenCalled()
  })

  it('verifies every duplicated immutable run column during replay', async () => {
    const creator = mockClient()
    creator.evalRun.findFirst.mockResolvedValueOnce(null)
    creator.evalRun.create.mockImplementationOnce(async ({ data }) => storedRun(data))
    const created = await createOrReplayEvaluationRun({
      db: creator as never,
      runId: RUN_ID,
      identity: identity(),
    })
    const mutations: Array<Record<string, unknown>> = [
      { tenantId: 'other' },
      { venueId: 'other' },
      { idempotencyKey: 'other' },
      { identityHash: '0'.repeat(64) },
      { corpusHash: '0'.repeat(64) },
      { caseManifestSnapshot: [] },
      { promptContractVersion: 'other' },
      { promptContractHash: '0'.repeat(64) },
      { packageSnapshotRef: 'other' },
      { packageSnapshotHash: '0'.repeat(64) },
      { contentSnapshotVersion: 43n },
      { contentSnapshotHash: '0'.repeat(64) },
      { modelProvider: 'other' },
      { modelName: 'other' },
      { modelSnapshotHash: '0'.repeat(64) },
      { modelSnapshot: { changed: true } },
      { runConfigSnapshot: { changed: true } },
      { identitySnapshot: { changed: true } },
      { declaredBudgetCeilingE8Usd: 1n },
      { createdBy: 'other' },
      { triggerType: 'other' },
    ]
    for (const mutation of mutations) {
      const replay = mockClient()
      replay.evalRun.findFirst.mockResolvedValueOnce({ ...created.run, ...mutation })
      await expect(
        createOrReplayEvaluationRun({ db: replay as never, runId: RUN_ID, identity: identity() }),
      ).rejects.toBeInstanceOf(EvaluationRunReplayConflictError)
    }
  })

  it('recovers an identical concurrent insert and conflicts on a different winner', async () => {
    const creator = mockClient()
    creator.evalRun.findFirst.mockResolvedValueOnce(null)
    creator.evalRun.create.mockImplementationOnce(async ({ data }) => storedRun(data))
    const expected = await createOrReplayEvaluationRun({
      db: creator as never,
      runId: RUN_ID,
      identity: identity(),
    })

    const raced = mockClient()
    raced.evalRun.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(expected.run)
    raced.evalRun.create.mockRejectedValueOnce({ code: 'P2002' })
    await expect(
      createOrReplayEvaluationRun({ db: raced as never, runId: RUN_ID, identity: identity() }),
    ).resolves.toEqual({ run: expected.run, replayed: true })

    raced.evalRun.findFirst.mockReset()
    raced.evalRun.create.mockReset()
    raced.evalRun.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...expected.run, identityHash: '0'.repeat(64) })
    raced.evalRun.create.mockRejectedValueOnce({ code: 'P2002' })
    await expect(
      createOrReplayEvaluationRun({ db: raced as never, runId: RUN_ID, identity: identity() }),
    ).rejects.toBeInstanceOf(EvaluationRunReplayConflictError)
  })

  it('rejects malformed hashes, UUIDs, and negative exact ceilings', async () => {
    const client = mockClient()
    await expect(
      createOrReplayEvaluationRun({
        db: client as never,
        runId: 'not-a-uuid',
        identity: identity(),
      }),
    ).rejects.toBeInstanceOf(EvaluationRunIdentityError)
    expect(() =>
      evaluationRunIdentityHash(
        identity({
          caseManifest: [
            {
              caseId: '22222222-2222-4222-8222-222222222222',
              revision: 1,
              caseHash: 'bad',
            },
          ],
        }),
      ),
    ).toThrow(EvaluationRunIdentityError)
    expect(() => evaluationRunIdentityHash(identity({ declaredBudgetCeilingE8Usd: -1n }))).toThrow(
      EvaluationRunIdentityError,
    )
    expect(() => evaluationRunIdentityHash(identity({ caseManifest: [] }))).toThrow(
      EvaluationRunIdentityError,
    )
    expect(() =>
      evaluationRunIdentityHash(
        identity({
          caseManifest: [
            { caseId: '22222222-2222-4222-8222-222222222222', revision: 1, caseHash: HASH_A },
            { caseId: '22222222-2222-4222-8222-222222222222', revision: 2, caseHash: HASH_B },
          ],
        }),
      ),
    ).toThrow(EvaluationRunIdentityError)
    expect(() =>
      evaluationRunIdentityHash(
        identity({ packageSnapshotRef: null, packageSnapshotHash: HASH_B }),
      ),
    ).toThrow(/must be paired/)
    expect(() =>
      evaluationRunIdentityHash(identity({ modelSnapshot: { é: 1, 'e\u0301': 2 } })),
    ).toThrow(/duplicate NFC-normalized keys/)
  })
})
