import { describe, expect, it, vi } from 'vitest'

import {
  PlatformReleaseEvidenceError,
  readPlatformReleaseEvidence,
  recordPlatformReleaseEvidenceAction,
} from './platform-release-evidence'

const assessment = {
  schemaVersion: 1 as const,
  generatedAt: '2026-08-25T04:01:22.858Z',
  revision: 'a'.repeat(40),
  profile: 'candidate' as const,
  readiness: 'ready-for-staging-review' as const,
  repository: { clean: true },
  summary: { passed: 1, failed: 0, blocked: 0 },
  gates: [{ id: 'typecheck', status: 'pass' as const, durationMs: 100 }],
  limitations: ['Hosted behavior remains unproven.'],
  rollback: {
    application: 'Redeploy the last admitted staging revision.',
    database: 'Repair forward.',
    runbook: 'docs/staging-release-workflow.md',
  },
}

const input = {
  operationId: '11111111-1111-4111-8111-111111111111',
  assessment,
  stagingHandoff: null,
  sourceReference: 'artifact://release/assessment.json',
  actor: { type: 'HUMAN' as const, id: 'founder-1', role: 'PLATFORM_ADMIN' as const },
}

function makeClient() {
  const release = {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'evidence-1',
      ...data,
      assessmentGeneratedAt: new Date(assessment.generatedAt),
      createdAt: new Date('2026-08-25T04:05:00.000Z'),
    })),
  }
  const transaction = {
    platformReleaseEvidence: release,
    platformWorkerPolicyCredential: {
      findFirst: vi.fn().mockResolvedValue({ id: 'credential-1' }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  return {
    transaction,
    client: {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    },
  }
}

describe('platform release evidence actions', () => {
  it('records immutable evidence and strict no-authority audit boundaries', async () => {
    const { client, transaction } = makeClient()
    const result = await recordPlatformReleaseEvidenceAction(input, client as never)

    expect(result).toMatchObject({ replayed: false, revision: assessment.revision })
    expect(transaction.platformReleaseEvidence.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          readiness: 'ready-for-staging-review',
          recordedByType: 'HUMAN',
          credentialId: null,
        }),
      }),
    )
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'platform-release-evidence.recorded',
        afterState: expect.objectContaining({
          deploysApplication: false,
          runsMigration: false,
          authorizesProduction: false,
        }),
      }),
    })
  })

  it('requires a live exact-capability credential for a machine recorder', async () => {
    const { client, transaction } = makeClient()
    transaction.platformWorkerPolicyCredential.findFirst.mockResolvedValue(null)

    await expect(
      recordPlatformReleaseEvidenceAction(
        {
          ...input,
          actor: {
            type: 'AGENT',
            id: 'release-worker',
            credentialId: 'credential-1',
            capability: 'release-evidence:record',
          },
        },
        client as never,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PlatformReleaseEvidenceError>>({
        code: 'INACTIVE_CREDENTIAL',
      }),
    )
    expect(transaction.platformReleaseEvidence.create).not.toHaveBeenCalled()
  })

  it('rejects a false-green report before opening a transaction', async () => {
    const { client } = makeClient()
    await expect(
      recordPlatformReleaseEvidenceAction(
        {
          ...input,
          assessment: { ...assessment, repository: { clean: false } },
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('returns a bounded current and historical projection', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'newest', revision: assessment.revision }])
    const result = await readPlatformReleaseEvidence(100, {
      platformReleaseEvidence: { findMany },
    } as never)
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }))
    expect(result.current).toMatchObject({ id: 'newest' })
    expect(result.boundaries).toMatchObject({
      evidenceOnly: true,
      stagingDeploymentAuthorized: false,
      productionDeploymentAuthorized: false,
    })
  })
})
