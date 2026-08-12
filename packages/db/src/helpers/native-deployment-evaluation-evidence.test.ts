/* eslint-disable @typescript-eslint/no-explicit-any -- bounded heterogeneous Prisma mocks. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const identityVerifier = vi.hoisted(() => vi.fn(() => true))
vi.mock('./evaluation-runs', async (original) => ({
  ...(await original<typeof import('./evaluation-runs')>()),
  isVerifiedEvaluationRunIdentity: identityVerifier,
}))

import { recordNativeDeploymentEvaluationEvidenceAction } from './native-deployment-evaluation-evidence'

const releaseId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const hash = 'a'.repeat(64)
const caseId = '44444444-4444-4444-8444-444444444444'
const completedAt = new Date('2026-08-12T12:00:00.000Z')

const input = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  releaseId,
  runId,
  expectedRunIdentityHash: hash,
  operationId,
  actor: { type: 'HUMAN' as const, role: 'PLATFORM_ADMIN' as const, id: 'admin-1' },
}

function fixture(outcome: string = 'SCORED', passed: boolean | null = true) {
  const tx: any = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    nativeVenueDeploymentRelease: {
      findFirst: vi.fn().mockResolvedValue({
        id: releaseId,
        artifactId: releaseId,
        manifestHash: 'b'.repeat(64),
        desiredStateHash: 'c'.repeat(64),
        status: 'DRAFT',
        plan: { priorHead: null },
      }),
    },
    nativeVenueDeploymentEvaluationEvidence: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) => ({ ...data, createdAt: new Date(0) })),
    },
    evalRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: runId,
        identityHash: hash,
        status: 'COMPLETED',
        completedAt,
        contentSnapshotKind: 'NATIVE_CORE_V1',
        contentSnapshotRef: releaseId,
        contentSnapshotVersion: 1n,
        contentSnapshotHash: 'c'.repeat(64),
        packageSnapshotRef: `native-core-v1:${releaseId}`,
        packageSnapshotHash: 'b'.repeat(64),
        caseManifestSnapshot: [{ caseId, revision: 1, caseHash: 'd'.repeat(64) }],
      }),
    },
    evalResult: {
      findMany: vi.fn().mockResolvedValue([
        {
          caseId,
          caseRevision: 1,
          caseHash: 'd'.repeat(64),
          outcome,
          passed,
          latencyMs: 25,
          costE8Usd: 7n,
        },
      ]),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  }
  return { tx, db: { $transaction: vi.fn((fn) => fn(tx)) } as any }
}

describe('native deployment evaluation evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    identityVerifier.mockReturnValue(true)
  })

  it('records bounded advisory PASS facts with strict audit and no release mutation', async () => {
    const { tx, db } = fixture()
    await expect(recordNativeDeploymentEvaluationEvidenceAction(input, db)).resolves.toMatchObject({
      disposition: 'PASS',
      manifestCaseCount: 1,
      passedCaseCount: 1,
      totalCostE8Usd: '7',
      advisoryOnly: true,
      replayed: false,
    })
    expect(tx.nativeVenueDeploymentEvaluationEvidence.create).toHaveBeenCalledOnce()
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
    expect(tx.nativeVenueDeploymentRelease.update).toBeUndefined()
  })

  it.each(['OPERATIONAL_FAILURE', 'ADMISSION_DEFERRED', 'BUDGET_BLOCKED', 'CANCELLED'])(
    'classifies %s as an operational failure',
    async (outcome) => {
      const { db } = fixture(outcome, null)
      await expect(
        recordNativeDeploymentEvaluationEvidenceAction(input, db),
      ).resolves.toMatchObject({
        disposition: 'OPERATIONAL_FAILURE',
        operationalFailureCount: 1,
      })
    },
  )

  it('fails closed for incomplete scored evidence', async () => {
    const { db } = fixture('SCORED', null)
    await expect(recordNativeDeploymentEvaluationEvidenceAction(input, db)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
  })

  it('classifies a completed scored failure as advisory quality evidence', async () => {
    const { db } = fixture('SCORED', false)
    await expect(recordNativeDeploymentEvaluationEvidenceAction(input, db)).resolves.toMatchObject({
      disposition: 'QUALITY_FAILURE',
      failedCaseCount: 1,
      operationalFailureCount: 0,
    })
  })

  it('rejects an unverified native run on create and replay', async () => {
    const first = fixture()
    identityVerifier.mockReturnValue(false)
    await expect(
      recordNativeDeploymentEvaluationEvidenceAction(input, first.db),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    const replay = fixture()
    identityVerifier.mockReturnValue(true)
    await recordNativeDeploymentEvaluationEvidenceAction(input, replay.db)
    const created = replay.tx.nativeVenueDeploymentEvaluationEvidence.create.mock.calls[0][0].data
    replay.tx.nativeVenueDeploymentEvaluationEvidence.findFirst.mockResolvedValue({
      ...created,
      createdAt: new Date(0),
    })
    identityVerifier.mockReturnValue(false)
    await expect(
      recordNativeDeploymentEvaluationEvidenceAction(input, replay.db),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
  })

  it('rejects an operation collision before reading result evidence', async () => {
    const { tx, db } = fixture()
    tx.nativeVenueDeploymentEvaluationEvidence.findFirst.mockResolvedValue({
      id: operationId,
      ...input,
      artifactId: releaseId,
      manifestHash: 'b'.repeat(64),
      desiredStateHash: 'c'.repeat(64),
      runIdentityHash: hash,
      runCompletedAt: completedAt,
      operationHash: 'different',
    })
    await expect(recordNativeDeploymentEvaluationEvidenceAction(input, db)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(tx.evalRun.findFirst).not.toHaveBeenCalled()
  })

  it('revalidates the exact durable run before returning an exact replay', async () => {
    const { tx, db } = fixture()
    await recordNativeDeploymentEvaluationEvidenceAction(input, db)
    const created = tx.nativeVenueDeploymentEvaluationEvidence.create.mock.calls[0][0].data
    tx.nativeVenueDeploymentEvaluationEvidence.findFirst.mockResolvedValue({
      ...created,
      createdAt: new Date(0),
    })
    await expect(recordNativeDeploymentEvaluationEvidenceAction(input, db)).resolves.toMatchObject({
      replayed: true,
      runId,
    })
    expect(tx.evalRun.findFirst).toHaveBeenCalledTimes(2)
    expect(tx.nativeVenueDeploymentEvaluationEvidence.create).toHaveBeenCalledOnce()
  })
})
