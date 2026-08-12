import { describe, expect, it, vi } from 'vitest'

import { compareEvaluationRuns } from './evaluation-run-comparison'

const baselineId = '11111111-1111-4111-8111-111111111111'
const candidateId = '22222222-2222-4222-8222-222222222222'
const caseA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const caseB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const manifest = [
  { caseId: caseA, revision: 2, caseHash: 'a'.repeat(64) },
  { caseId: caseB, revision: 1, caseHash: 'b'.repeat(64) },
]

function run(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    identityHash: (id === baselineId ? '1' : '2').repeat(64),
    corpusHash: 'c'.repeat(64),
    caseManifestSnapshot: manifest,
    promptContractVersion: 'prompt-v1',
    promptContractHash: 'd'.repeat(64),
    packageSnapshotRef: null,
    packageSnapshotHash: null,
    contentSnapshotVersion: 7n,
    contentSnapshotHash: 'e'.repeat(64),
    modelProvider: 'openai',
    modelName: 'gpt-safe',
    modelSnapshotHash: 'f'.repeat(64),
    runConfigSnapshot: { temperature: 0, maximumTokens: 500 },
    status: 'COMPLETED',
    createdAt: new Date(id === baselineId ? '2026-08-12T10:00:00Z' : '2026-08-12T11:00:00Z'),
    ...overrides,
  }
}

function result(
  id: string,
  runId: string,
  caseId: string,
  revision: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    runId,
    caseId,
    caseRevision: revision,
    caseHash: caseId === caseA ? 'a'.repeat(64) : 'b'.repeat(64),
    outcome: 'SCORED',
    passed: true,
    passedChecks: 4,
    totalChecks: 4,
    errorCode: null,
    latencyMs: 100,
    costE8Usd: 1000n,
    reviews: [],
    ...overrides,
  }
}

function fixture(runs = [run(baselineId), run(candidateId)]) {
  const client = {
    evalRun: { findMany: vi.fn().mockResolvedValue(runs) },
    evalCase: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: caseA,
          caseKey: 'admission-hours',
          revision: 2,
          caseHash: 'a'.repeat(64),
          category: 'grounding',
        },
        {
          id: caseB,
          caseKey: 'parking',
          revision: 1,
          caseHash: 'b'.repeat(64),
          category: 'navigation',
        },
      ]),
    },
    evalResult: { findMany: vi.fn() },
  }
  return client
}

const scope = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  baselineRunId: baselineId,
  candidateRunId: candidateId,
}

describe('compareEvaluationRuns', () => {
  it('classifies exact stable case revisions and returns bounded safe deltas', async () => {
    const client = fixture()
    client.evalResult.findMany.mockResolvedValue([
      result('result-a-before', baselineId, caseA, 2),
      result('result-a-after', candidateId, caseA, 2, {
        passed: false,
        passedChecks: 2,
        latencyMs: 140,
        costE8Usd: 1300n,
      }),
      result('result-b-before', baselineId, caseB, 1, {
        outcome: 'OPERATIONAL_FAILURE',
        passed: null,
        passedChecks: null,
        totalChecks: null,
        errorCode: 'PROVIDER_TIMEOUT',
      }),
      result('result-b-after', candidateId, caseB, 1, {
        latencyMs: 90,
        costE8Usd: 800n,
      }),
    ])

    const compared = await compareEvaluationRuns(scope, client as never)
    expect(compared.status).toBe('COMPARABLE')
    if (compared.status !== 'COMPARABLE') throw new Error('Expected comparable evidence')
    expect(compared.cases).toEqual([
      expect.objectContaining({
        caseKey: 'admission-hours',
        caseRevision: 2,
        classification: 'NEW_FAILURE',
        latencyDeltaMs: 40,
        costDeltaE8Usd: '300',
        scoreDeltaBasisPoints: -5000,
      }),
      expect.objectContaining({ caseKey: 'parking', classification: 'RESOLVED_FAILURE' }),
    ])
    expect(compared.totals).toMatchObject({
      caseCount: 2,
      newFailures: 1,
      resolvedFailures: 1,
      unchangedFailures: 0,
      missingResults: 0,
      latencyDeltaMs: 30,
      costDeltaE8Usd: '100',
    })
    expect(JSON.stringify(compared)).not.toMatch(/observation|checksSnapshot|caseHash|sourceRef/u)
  })

  it.each([
    ['CORPUS', { corpusHash: '9'.repeat(64) }],
    ['CONTENT', { contentSnapshotHash: '9'.repeat(64) }],
    ['MODEL', { modelSnapshotHash: '9'.repeat(64) }],
    ['CONFIG', { runConfigSnapshot: { temperature: 1 } }],
  ])(
    'returns INCOMPARABLE for a %s mismatch without reading cases/results',
    async (reason, change) => {
      const client = fixture([run(baselineId), run(candidateId, change)])
      const compared = await compareEvaluationRuns(scope, client as never)
      expect(compared).toMatchObject({
        status: 'INCOMPARABLE',
        mismatchReasons: expect.arrayContaining([reason]),
        cases: [],
        totals: null,
      })
      expect(client.evalCase.findMany).not.toHaveBeenCalled()
      expect(client.evalResult.findMany).not.toHaveBeenCalled()
    },
  )

  it('classifies absent terminal evidence without inventing a result', async () => {
    const client = fixture()
    client.evalResult.findMany.mockResolvedValue([
      result('result-a-before', baselineId, caseA, 2),
      result('result-b-after', candidateId, caseB, 1),
    ])
    const compared = await compareEvaluationRuns(scope, client as never)
    if (compared.status !== 'COMPARABLE') throw new Error('Expected comparable evidence')
    expect(compared.cases.map((row) => row.classification)).toEqual([
      'CANDIDATE_RESULT_MISSING',
      'BASELINE_RESULT_MISSING',
    ])
    expect(compared.totals.missingResults).toBe(2)
  })

  it('fails closed when a result case hash disagrees with the frozen manifest', async () => {
    const client = fixture()
    client.evalResult.findMany.mockResolvedValue([
      result('result-a-before', baselineId, caseA, 2, { caseHash: '9'.repeat(64) }),
    ])
    await expect(compareEvaluationRuns(scope, client as never)).resolves.toMatchObject({
      status: 'INCOMPARABLE',
      mismatchReasons: ['EVIDENCE'],
      cases: [],
      totals: null,
    })
  })

  it('fails closed on duplicate manifest or result identities', async () => {
    const duplicateManifestClient = fixture([
      run(baselineId, { caseManifestSnapshot: [manifest[0], manifest[0]] }),
      run(candidateId, { caseManifestSnapshot: [manifest[0], manifest[0]] }),
    ])
    await expect(
      compareEvaluationRuns(scope, duplicateManifestClient as never),
    ).resolves.toMatchObject({ status: 'INCOMPARABLE', mismatchReasons: ['EVIDENCE'] })
    expect(duplicateManifestClient.evalCase.findMany).not.toHaveBeenCalled()

    const duplicateResultClient = fixture()
    const duplicated = result('result-a-before', baselineId, caseA, 2)
    duplicateResultClient.evalResult.findMany.mockResolvedValue([
      duplicated,
      { ...duplicated, id: 'duplicate-result' },
    ])
    await expect(
      compareEvaluationRuns(scope, duplicateResultClient as never),
    ).resolves.toMatchObject({ status: 'INCOMPARABLE', mismatchReasons: ['EVIDENCE'] })
  })

  it('fails nondisclosing when either exact-scoped run is absent', async () => {
    const client = fixture([run(baselineId)])
    await expect(compareEvaluationRuns(scope, client as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'One or both evaluation runs were not found.',
    })
    expect(client.evalCase.findMany).not.toHaveBeenCalled()
  })

  it('rejects comparing a run with itself before reading persistence', async () => {
    const client = fixture()
    await expect(
      compareEvaluationRuns({ ...scope, candidateRunId: baselineId }, client as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.evalRun.findMany).not.toHaveBeenCalled()
  })
})
