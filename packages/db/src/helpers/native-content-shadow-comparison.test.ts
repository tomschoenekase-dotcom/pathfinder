import { describe, expect, it, vi } from 'vitest'

import { compareNativeContentShadowRuns } from './native-content-shadow-comparison'

const baselineId = '11111111-1111-4111-8111-111111111111'
const candidateId = '22222222-2222-4222-8222-222222222222'
const releaseId = '33333333-3333-4333-8333-333333333333'
const caseId = '44444444-4444-4444-8444-444444444444'
const manifest = [{ caseId, revision: 1, caseHash: 'a'.repeat(64) }]

function run(
  id: string,
  kind: 'LEGACY_VENUE_CONTENT_V1' | 'NATIVE_CORE_V1',
  overrides: Record<string, unknown> = {},
) {
  const native = kind === 'NATIVE_CORE_V1'
  return {
    id,
    identityHash: (native ? '2' : '1').repeat(64),
    corpusHash: 'b'.repeat(64),
    caseManifestSnapshot: manifest,
    promptContractVersion: 'guest-chat-v1',
    promptContractHash: 'c'.repeat(64),
    packageSnapshotRef: native ? `native-core-v1:${releaseId}` : null,
    packageSnapshotHash: native ? 'd'.repeat(64) : null,
    contentSnapshotKind: kind,
    contentSnapshotRef: native ? releaseId : 'legacy-snapshot',
    contentSnapshotVersion: native ? 2n : 1n,
    contentSnapshotHash: (native ? 'e' : 'f').repeat(64),
    modelProvider: 'openai',
    modelName: 'gpt-safe',
    modelSnapshotHash: '9'.repeat(64),
    runConfigSnapshot: native ? { version: 'native-v1' } : { version: 'legacy-v1' },
    status: 'COMPLETED',
    createdAt: new Date(native ? '2026-08-23T11:00:00Z' : '2026-08-23T10:00:00Z'),
    ...overrides,
  }
}

function fixture(
  runs = [run(baselineId, 'LEGACY_VENUE_CONTENT_V1'), run(candidateId, 'NATIVE_CORE_V1')],
) {
  return {
    nativeVenueDeploymentRelease: { findFirst: vi.fn().mockResolvedValue({ id: releaseId }) },
    evalRun: { findMany: vi.fn().mockResolvedValue(runs) },
    evalCase: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: caseId,
          caseKey: 'admission-hours',
          revision: 1,
          caseHash: 'a'.repeat(64),
          category: 'known-answer',
        },
      ]),
    },
    evalResult: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'result-before',
          runId: baselineId,
          caseId,
          caseRevision: 1,
          caseHash: 'a'.repeat(64),
          outcome: 'SCORED',
          passed: true,
          passedChecks: 4,
          totalChecks: 4,
          errorCode: null,
          latencyMs: 100,
          costE8Usd: 100n,
          reviews: [],
        },
        {
          id: 'result-after',
          runId: candidateId,
          caseId,
          caseRevision: 1,
          caseHash: 'a'.repeat(64),
          outcome: 'SCORED',
          passed: false,
          passedChecks: 3,
          totalChecks: 4,
          errorCode: null,
          latencyMs: 110,
          costE8Usd: 120n,
          reviews: [],
        },
      ]),
    },
  }
}

const input = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  releaseId,
  baselineRunId: baselineId,
  candidateRunId: candidateId,
}

describe('compareNativeContentShadowRuns', () => {
  it('declares only content/config change and returns non-authorizing raw evidence', async () => {
    const result = await compareNativeContentShadowRuns(input, fixture() as never)
    expect(result).toMatchObject({
      status: 'COMPARABLE_WITH_DECLARED_CHANGE',
      declaredChangeReasons: ['CONFIG', 'CONTENT'],
      totals: { caseCount: 1, newFailures: 1, resolvedFailures: 0 },
      measurement: 'LEGACY_TO_NATIVE_GUEST_CONTENT_SHADOW_V1',
      advisoryOnly: true,
      guestReadPathChanged: false,
      cutoverAuthorized: false,
      legacyRetirementAuthorized: false,
    })
  })

  it('fails closed when model identity also changed', async () => {
    const client = fixture([
      run(baselineId, 'LEGACY_VENUE_CONTENT_V1'),
      run(candidateId, 'NATIVE_CORE_V1', { modelSnapshotHash: '8'.repeat(64) }),
    ])
    await expect(compareNativeContentShadowRuns(input, client as never)).resolves.toMatchObject({
      status: 'INCOMPARABLE',
      mismatchReasons: ['MODEL'],
      totals: null,
    })
    expect(client.evalCase.findMany).not.toHaveBeenCalled()
  })

  it('rejects a candidate that is not exact completed evidence for the release', async () => {
    const client = fixture([
      run(baselineId, 'LEGACY_VENUE_CONTENT_V1'),
      run(candidateId, 'NATIVE_CORE_V1', { contentSnapshotRef: 'another-release' }),
    ])
    await expect(compareNativeContentShadowRuns(input, client as never)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(client.evalCase.findMany).not.toHaveBeenCalled()
  })

  it('does not accept a native or unfinished run as the legacy baseline', async () => {
    const client = fixture([
      run(baselineId, 'NATIVE_CORE_V1', { status: 'RUNNING' }),
      run(candidateId, 'NATIVE_CORE_V1'),
    ])
    await expect(compareNativeContentShadowRuns(input, client as never)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
  })
})
