import { createHash } from 'node:crypto'

import { AI_MODEL_KEYS, getAiModelSpec } from '@pathfinder/ai'
import { canonicalEvaluationJson, type CanonicalJsonValue } from '@pathfinder/contracts/evaluation'
import { nativeCoreVisibleStateHash } from '@pathfinder/contracts/native-venue-deployment'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'
import { evaluationSnapshotHash, hashEvalCase } from '@pathfinder/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycleMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  writeJobRecord: vi.fn(),
  updateJobRecord: vi.fn(),
  claimEvaluationRunAttempt: vi.fn(),
  finishEvaluationRunAttempt: vi.fn(),
  failEvaluationRunAttempt: vi.fn(),
  recordApprovedPackageEvaluationMilestones: vi.fn(),
  getEvaluationRegressionAlertPolicy: vi.fn(),
}))

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  writeJobRecord: lifecycleMocks.writeJobRecord,
  updateJobRecord: lifecycleMocks.updateJobRecord,
  claimEvaluationRunAttempt: lifecycleMocks.claimEvaluationRunAttempt,
  finishEvaluationRunAttempt: lifecycleMocks.finishEvaluationRunAttempt,
  failEvaluationRunAttempt: lifecycleMocks.failEvaluationRunAttempt,
  recordApprovedPackageEvaluationMilestones:
    lifecycleMocks.recordApprovedPackageEvaluationMilestones,
  getEvaluationRegressionAlertPolicy: lifecycleMocks.getEvaluationRegressionAlertPolicy,
}))

vi.mock('@pathfinder/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/ai')>()),
  generateText: lifecycleMocks.generateText,
}))

vi.mock('@pathfinder/config', () => ({
  env: { EVALUATION_RUNNER_ENABLED: false },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import {
  assertFinalEvaluationProviderAdmission,
  detectEvaluationRegression,
  executeFrozenEvaluationRun,
  evaluationPromptCostCeiling,
  frozenContent,
  processEvaluationRunJob,
  type EvaluationRunnerDependencies,
} from './evaluation-run'

describe('evaluation regression detection', () => {
  it('flags a material pass-rate drop and ignores noise below the threshold', () => {
    expect(
      detectEvaluationRegression({
        currentPassed: 8,
        currentScored: 10,
        previousPassed: 10,
        previousScored: 10,
        minimumDrop: 0.05,
      }),
    ).toMatchObject({ currentRate: 0.8, previousRate: 1, drop: 0.2 })
    expect(
      detectEvaluationRegression({
        currentPassed: 96,
        currentScored: 100,
        previousPassed: 98,
        previousScored: 100,
        minimumDrop: 0.05,
      }),
    ).toBeNull()
  })

  it('does not infer quality from runs without scored cases', () => {
    expect(
      detectEvaluationRegression({
        currentPassed: 0,
        currentScored: 0,
        previousPassed: 4,
        previousScored: 5,
        minimumDrop: 0.05,
      }),
    ).toBeNull()
  })
})

const id = '11111111-1111-4111-8111-111111111111'
const identityHash = 'a'.repeat(64)
const evalCase = {
  schemaVersion: 'pathfinder-eval-v1' as const,
  caseId: 'known-case',
  category: 'known-answer' as const,
  venue: {
    fixtureId: 'venue',
    guideMode: 'location_aware' as const,
    placeNameUniverse: [],
    allowedPlaceNames: [],
  },
  turns: [{ role: 'user' as const, content: 'Where?' }],
  rules: {
    requiredPhrases: [{ ruleId: 'answer', phrase: 'here' }],
    requiredFacts: [],
    forbiddenPhrases: [],
    maxWords: 10,
    unknownAnswer: { required: false, ruleId: 'unknown', acceptablePhrases: [] },
  },
}
const caseHash = hashEvalCase(evalCase)
const model = getAiModelSpec(AI_MODEL_KEYS.GUEST_CHAT)
const contentSnapshot = {
  schemaVersion: 'pathfinder-venue-content-snapshot-v1',
  tenantId: 't1',
  venueId: 'v1',
  promptIdentity: {
    version: GUEST_CHAT_PROMPT_VERSION,
    hash: GUEST_CHAT_PROMPT_CONTRACT_HASH,
  },
  venue: { id: 'v1', name: 'Frozen venue' },
  places: [],
  knowledgeEntries: [],
  operationalUpdates: [],
  universalRevisions: [],
} as CanonicalJsonValue
const contentSnapshotHash = createHash('sha256')
  .update(`pathfinder-venue-content-snapshot-v1\n${canonicalEvaluationJson(contentSnapshot)}`)
  .digest('hex')
const payload = { tenantId: 't1', venueId: 'v1', runId: id, runIdentityHash: identityHash }
const nativeState = {
  venueBotConfiguration: {
    presentationMode: 'CLASSIC',
    personalityMode: 'PRESET',
    tonePreset: 'friendly',
    tonePresetVersion: 1,
    personalityProfileId: null,
    characterKey: null,
    customCharacterId: null,
    publicDisplayName: null,
    greeting: null,
    voiceProfileId: null,
  },
  venue: {
    name: 'Venue',
    slug: 'venue',
    description: null,
    guideNotes: null,
    aiGuideNotes: null,
    aiFeaturedPlaceId: null,
    aiTone: 'FRIENDLY',
    tonePreset: 'friendly',
    tonePresetVersion: 1,
    aiGuideName: null,
    chatTheme: 'default',
    chatAccentColor: null,
    chatFont: 'jakarta',
    chatLogoUrl: null,
    chatBannerUrl: null,
    category: null,
    guideMode: 'location_aware',
    defaultCenterLat: null,
    defaultCenterLng: null,
    geoBoundary: null,
    isActive: true,
  },
  places: [],
  knowledgeEntries: [],
  generalizedModules: [],
} as const

function frozenRun() {
  return {
    id,
    tenantId: 't1',
    venueId: 'v1',
    identityHash,
    caseManifestSnapshot: [{ caseId: id, revision: 1, caseHash }],
    promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
    promptContractHash: GUEST_CHAT_PROMPT_CONTRACT_HASH,
    contentSnapshotVersion: 1n,
    contentSnapshotHash,
    modelProvider: model.provider,
    modelName: model.model,
    modelSnapshotHash: evaluationSnapshotHash('pathfinder-eval-model-snapshot-v1', model as never),
    modelSnapshot: model,
    runConfigSnapshot: {
      version: 'pathfinder-evaluation-run-config-v1',
      contentSnapshot,
    },
    declaredBudgetCeilingE8Usd: 10n,
  }
}

function deps(overrides: Partial<EvaluationRunnerDependencies> = {}): EvaluationRunnerDependencies {
  return {
    loadRun: async () => frozenRun(),
    loadCases: async () => [{ id, revision: 1, caseHash, caseSnapshot: evalCase }],
    loadExistingResults: async () => [],
    evaluate: async () => ({
      answer: 'It is here',
      latencyMs: 4,
      costE8Usd: 3n,
      modelProvider: model.provider,
      modelName: model.model,
    }),
    renewLease: vi.fn(async () => true),
    reserve: vi.fn(async () => ({ state: 'reserved' as const, reservationId: 'reservation-1' })),
    persist: vi.fn(async () => undefined),
    isCancelled: async () => false,
    isCancellationRequested: async () => false,
    ...overrides,
  }
}

describe('executeFrozenEvaluationRun', () => {
  it('parses and re-hashes only the frozen approved client-package preview', () => {
    const preview = {
      venue: {
        id: 'v1',
        name: 'Frozen approved venue',
        description: null,
        category: null,
        branding: {
          theme: null,
          accentColor: null,
          font: null,
          logoUrl: null,
          bannerUrl: null,
        },
        guide: { name: null, tone: { preset: 'friendly', behaviorVersion: 1 } },
      },
      package: {
        id: 'package_1',
        status: 'APPROVED',
        approvedAt: '2026-08-18T12:00:00.000Z',
      },
      experience: {
        places: [],
        knowledgeEntries: [],
        summary: { placeCount: 0, knowledgeEntryCount: 0 },
      },
      staleness: 'CURRENT',
      autoApply: false,
      published: false,
      guestAccessible: false,
    } as const
    const approvedContent = {
      version: 'pathfinder-approved-package-evaluation-content-v1',
      tenantId: 't1',
      venueId: 'v1',
      packageId: 'package_1',
      preview,
    }
    const run = {
      ...frozenRun(),
      contentSnapshotKind: 'APPROVED_VENUE_PACKAGE_V1' as const,
      contentSnapshotRef: 'package_1',
      contentSnapshotHash: evaluationSnapshotHash(
        'pathfinder-approved-client-package-preview-v1',
        approvedContent as never,
      ),
      runConfigSnapshot: {
        version: 'pathfinder-approved-package-evaluation-run-config-v1',
        contentSnapshot: approvedContent,
      },
    }
    expect(frozenContent(run)).toEqual(approvedContent)
    expect(() =>
      frozenContent({
        ...run,
        runConfigSnapshot: {
          ...run.runConfigSnapshot,
          contentSnapshot: {
            ...approvedContent,
            preview: { ...preview, venue: { ...preview.venue, name: 'Tampered' } },
          },
        },
      }),
    ).toThrow('EVALUATION_CONTENT_IDENTITY_MISMATCH')
  })

  it('parses and re-hashes only the frozen native desired-state snapshot', () => {
    const nativeContent = {
      version: 'pathfinder-native-evaluation-content-v1',
      tenantId: 't1',
      venueId: 'v1',
      releaseId: id,
      state: nativeState,
    }
    const run = {
      ...frozenRun(),
      contentSnapshotKind: 'NATIVE_CORE_V1' as const,
      contentSnapshotRef: id,
      contentSnapshotHash: nativeCoreVisibleStateHash(nativeState),
      runConfigSnapshot: {
        version: 'pathfinder-native-evaluation-run-config-v1',
        contentSnapshot: nativeContent,
      },
    }
    expect(frozenContent(run)).toEqual(nativeContent)
    expect(() =>
      frozenContent({
        ...run,
        runConfigSnapshot: {
          ...run.runConfigSnapshot,
          contentSnapshot: { ...nativeContent, state: { ...nativeState, places: [{}] } },
        },
      }),
    ).toThrow('EVALUATION_CONTENT_IDENTITY_MISMATCH')
  })

  it('scores quality separately and records bounded cost', async () => {
    const subject = deps()
    const result = await executeFrozenEvaluationRun(payload, subject, { finalAttempt: true })
    expect(result).toEqual({ processed: 1, costE8Usd: 3n, cancelled: 0 })
    expect(subject.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({ outcome: 'SCORED', costE8Usd: 3n }),
      }),
    )
  })

  it('terminalizes an uncertain provider failure and never leaves it eligible for redispatch', async () => {
    const subject = deps({
      evaluate: vi.fn(async () => {
        throw new Error('provider down')
      }),
    })
    await executeFrozenEvaluationRun(payload, subject, { finalAttempt: false })
    expect(subject.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({ errorCode: 'PROVIDER_OUTCOME_AMBIGUOUS' }),
        reservation: { id: 'reservation-1', settlement: 'ambiguous' },
      }),
    )
  })

  it('skips terminal results and carries their exact cost into a retry budget', async () => {
    const secondId = '22222222-2222-4222-8222-222222222222'
    const secondCase = { ...evalCase, caseId: 'second-case' }
    const secondHash = hashEvalCase(secondCase)
    const evaluate = vi.fn(async () => ({
      answer: 'It is here',
      latencyMs: 4,
      costE8Usd: 2n,
      modelProvider: model.provider,
      modelName: model.model,
    }))
    const subject = deps({
      loadRun: async () => ({
        ...frozenRun(),
        caseManifestSnapshot: [
          { caseId: id, revision: 1, caseHash },
          { caseId: secondId, revision: 1, caseHash: secondHash },
        ],
      }),
      loadCases: async () => [
        { id, revision: 1, caseHash, caseSnapshot: evalCase },
        { id: secondId, revision: 1, caseHash: secondHash, caseSnapshot: secondCase },
      ],
      loadExistingResults: async () => [{ caseId: id, caseRevision: 1, caseHash, costE8Usd: 3n }],
      evaluate,
    })
    const result = await executeFrozenEvaluationRun(payload, subject, { finalAttempt: true })
    expect(result).toEqual({ processed: 2, costE8Usd: 5n, cancelled: 0 })
    expect(evaluate).toHaveBeenCalledOnce()
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ evalCase: secondCase, remainingBudgetE8Usd: 7n }),
    )
  })

  it('records final operational failure without turning it into a quality failure', async () => {
    const subject = deps({
      evaluate: vi.fn(async () => {
        throw new Error('provider down')
      }),
    })
    await executeFrozenEvaluationRun(payload, subject, { finalAttempt: true })
    expect(subject.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({ outcome: 'OPERATIONAL_FAILURE' }),
      }),
    )
  })

  it('does not redispatch when a prior durable reservation has an ambiguous provider outcome', async () => {
    const evaluate = vi.fn()
    const subject = deps({
      reserve: vi.fn(async () => ({
        state: 'ambiguous' as const,
        reservationId: 'prior-reservation',
      })),
      evaluate,
    })
    await executeFrozenEvaluationRun(payload, subject, { finalAttempt: false, attemptNumber: 2 })
    expect(evaluate).not.toHaveBeenCalled()
    expect(subject.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({ errorCode: 'PROVIDER_OUTCOME_AMBIGUOUS' }),
        reservation: { id: 'prior-reservation', settlement: 'ambiguous' },
      }),
    )
  })

  it('blocks before provider I/O when durable reservation would exceed the run ceiling', async () => {
    const evaluate = vi.fn()
    const subject = deps({
      reserve: vi.fn(async () => ({ state: 'budget-blocked' as const })),
      evaluate,
    })
    await executeFrozenEvaluationRun(payload, subject, { finalAttempt: true })
    expect(evaluate).not.toHaveBeenCalled()
    expect(subject.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({ outcome: 'BUDGET_BLOCKED' }),
      }),
    )
  })

  it('stops a multi-case run when its fenced lease expires between cases', async () => {
    const secondId = '22222222-2222-4222-8222-222222222222'
    const secondCase = { ...evalCase, caseId: 'second-case' }
    const secondHash = hashEvalCase(secondCase)
    const evaluate = vi.fn(async () => ({
      answer: 'here',
      latencyMs: 1,
      costE8Usd: 1n,
      modelProvider: model.provider,
      modelName: model.model,
    }))
    const renewLease = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const subject = deps({
      loadRun: async () => ({
        ...frozenRun(),
        declaredBudgetCeilingE8Usd: 100n,
        caseManifestSnapshot: [
          { caseId: id, revision: 1, caseHash },
          { caseId: secondId, revision: 1, caseHash: secondHash },
        ],
      }),
      loadCases: async () => [
        { id, revision: 1, caseHash, caseSnapshot: evalCase },
        { id: secondId, revision: 1, caseHash: secondHash, caseSnapshot: secondCase },
      ],
      renewLease,
      evaluate,
    })
    await expect(
      executeFrozenEvaluationRun(payload, subject, {
        finalAttempt: false,
        attemptNumber: 1,
        leaseToken: id,
      }),
    ).rejects.toThrow('EVALUATION_RUN_LEASE_LOST')
    expect(evaluate).toHaveBeenCalledOnce()
    expect(renewLease).toHaveBeenCalledTimes(2)
    expect(subject.persist).toHaveBeenCalledTimes(1)
  })

  it('classifies durable cancellation separately when between-case renewal is rejected', async () => {
    const subject = deps({
      renewLease: vi.fn(async () => false),
      isCancellationRequested: vi.fn(async () => true),
    })

    await expect(
      executeFrozenEvaluationRun(payload, subject, {
        finalAttempt: false,
        attemptNumber: 1,
        leaseToken: id,
      }),
    ).rejects.toMatchObject({ code: 'execution-lease-cancelled' })
    expect(subject.persist).not.toHaveBeenCalled()
  })

  it('rechecks durable cancellation last at final provider admission', async () => {
    const order: string[] = []
    await expect(
      assertFinalEvaluationProviderAdmission({
        signalAborted: false,
        globalEnabled: async () => (order.push('global'), true),
        renewLease: async () => (order.push('lease'), true),
        venueAvailable: async () => {
          order.push('venue')
        },
        tenantEnabled: async () => (order.push('tenant'), true),
        cancellationRequested: async () => (order.push('cancelled-after-reservation'), true),
      }),
    ).rejects.toThrow('EVALUATION_RUN_CANCELLED')
    expect(order).toEqual(['global', 'lease', 'venue', 'tenant', 'cancelled-after-reservation'])
    expect(lifecycleMocks.generateText).not.toHaveBeenCalled()
  })

  it('hard-stops cost above the frozen ceiling', async () => {
    const subject = deps({
      evaluate: async () => ({
        answer: 'here',
        latencyMs: 2,
        costE8Usd: 11n,
        modelProvider: model.provider,
        modelName: model.model,
      }),
    })
    const result = await executeFrozenEvaluationRun(payload, subject, { finalAttempt: true })
    expect(result.costE8Usd).toBe(0n)
    expect(subject.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({
          outcome: 'OPERATIONAL_FAILURE',
          errorCode: 'PROVIDER_COST_INVARIANT',
        }),
        reservation: { id: 'reservation-1', settlement: 'ambiguous' },
      }),
    )
  })

  it('bounds the frozen provider prompt before dispatch', () => {
    expect(evaluationPromptCostCeiling(evalCase, contentSnapshot)).toBeGreaterThan(0n)
    expect(() =>
      evaluationPromptCostCeiling(evalCase, {
        ...(contentSnapshot as Record<string, CanonicalJsonValue>),
        oversized: 'x'.repeat(model.maxInputUtf8Bytes + 1),
      } as CanonicalJsonValue),
    ).toThrow('input boundary')
    expect(lifecycleMocks.generateText).not.toHaveBeenCalled()
  })

  it('cancels without dispatching when the tenant or process gate closes', async () => {
    const evaluate = vi.fn()
    const subject = deps({ isCancelled: async () => true, evaluate })
    await executeFrozenEvaluationRun(payload, subject, { finalAttempt: true })
    expect(evaluate).not.toHaveBeenCalled()
    expect(subject.persist).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: expect.objectContaining({ outcome: 'CANCELLED' }) }),
    )
  })

  it('rejects changed content, model, case, or scope identities before evaluation', async () => {
    for (const changed of [
      { tenantId: 'other' },
      { contentSnapshotHash: 'b'.repeat(64) },
      { modelName: 'changed-model' },
    ]) {
      const evaluate = vi.fn()
      const subject = deps({ loadRun: async () => ({ ...frozenRun(), ...changed }), evaluate })
      await expect(
        executeFrozenEvaluationRun(payload, subject, { finalAttempt: true }),
      ).rejects.toThrow()
      expect(evaluate).not.toHaveBeenCalled()
    }

    const evaluate = vi.fn()
    const subject = deps({
      loadCases: async () => [
        { id, revision: 1, caseHash, caseSnapshot: { ...evalCase, caseId: 'changed-case' } },
      ],
      evaluate,
    })
    await expect(
      executeFrozenEvaluationRun(payload, subject, { finalAttempt: true }),
    ).rejects.toThrow('CASE_SNAPSHOT_HASH_MISMATCH')
    expect(evaluate).not.toHaveBeenCalled()
  })
})

describe('processEvaluationRunJob lifecycle', () => {
  beforeEach(() => {
    for (const mock of Object.values(lifecycleMocks)) mock.mockClear()
    lifecycleMocks.recordApprovedPackageEvaluationMilestones.mockResolvedValue({
      eligible: true,
      recorded: 0,
    })
    lifecycleMocks.getEvaluationRegressionAlertPolicy.mockResolvedValue(null)
  })
  it('brackets an exact attempt with JobRecord evidence without calling a provider', async () => {
    lifecycleMocks.claimEvaluationRunAttempt.mockResolvedValueOnce({
      state: 'acquired',
      cancellationRequested: false,
      attemptNumber: 1,
      leaseToken: '11111111-1111-4111-8111-111111111111',
    })
    lifecycleMocks.finishEvaluationRunAttempt.mockResolvedValueOnce(true)
    lifecycleMocks.writeJobRecord.mockResolvedValueOnce('job_record_1')
    lifecycleMocks.updateJobRecord.mockResolvedValueOnce(undefined)
    await processEvaluationRunJob(
      payload,
      { bullJobId: 'bull_1', attemptNumber: 1, maxAttempts: 3 },
      undefined,
      deps(),
    )
    expect(lifecycleMocks.writeJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: expect.stringContaining('evaluation-run'),
        jobName: 'evaluation-run-process',
        bullJobId: 'bull_1',
        tenantId: 't1',
        status: 'RUNNING',
        payload,
        attemptNumber: 1,
        maxAttempts: 3,
      }),
    )
    expect(lifecycleMocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
    expect(lifecycleMocks.generateText).not.toHaveBeenCalled()
  })

  it('records retry eligibility and rethrows before the final attempt', async () => {
    lifecycleMocks.claimEvaluationRunAttempt.mockResolvedValueOnce({
      state: 'acquired',
      cancellationRequested: false,
      attemptNumber: 2,
      leaseToken: '22222222-2222-4222-8222-222222222222',
    })
    lifecycleMocks.failEvaluationRunAttempt.mockResolvedValueOnce('retry-eligible')
    lifecycleMocks.writeJobRecord.mockResolvedValueOnce('job_record_2')
    lifecycleMocks.updateJobRecord.mockResolvedValueOnce(undefined)
    await expect(
      processEvaluationRunJob(
        payload,
        { bullJobId: 'bull_2', attemptNumber: 2, maxAttempts: 3 },
        undefined,
        deps({
          reserve: async () => {
            throw new Error('reservation unavailable')
          },
        }),
      ),
    ).rejects.toThrow('reservation unavailable')
    expect(lifecycleMocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_2',
      expect.objectContaining({
        status: 'FAILED',
        attemptNumber: 2,
        maxAttempts: 3,
        failureDisposition: 'RETRY_ELIGIBLE',
      }),
    )
    expect(lifecycleMocks.generateText).not.toHaveBeenCalled()
  })

  it('completes a durably cancelled run without failure settlement after renewal loss', async () => {
    lifecycleMocks.claimEvaluationRunAttempt.mockResolvedValueOnce({
      state: 'acquired',
      cancellationRequested: false,
      attemptNumber: 1,
      leaseToken: id,
    })
    lifecycleMocks.finishEvaluationRunAttempt.mockResolvedValueOnce(true)
    lifecycleMocks.writeJobRecord.mockResolvedValueOnce('job_record_cancel')
    lifecycleMocks.updateJobRecord.mockResolvedValueOnce(undefined)

    await processEvaluationRunJob(payload, undefined, undefined, {
      ...deps(),
      renewLease: async () => false,
      isCancellationRequested: async () => true,
    })

    expect(lifecycleMocks.finishEvaluationRunAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: id, outcome: 'CANCELLED' }),
    )
    expect(lifecycleMocks.failEvaluationRunAttempt).not.toHaveBeenCalled()
    expect(lifecycleMocks.updateJobRecord).toHaveBeenCalledWith('job_record_cancel', {
      status: 'COMPLETE',
    })
  })

  it('does not stale-settle lifecycle state when a takeover rejects renewal', async () => {
    lifecycleMocks.claimEvaluationRunAttempt.mockResolvedValueOnce({
      state: 'acquired',
      cancellationRequested: false,
      attemptNumber: 1,
      leaseToken: id,
    })
    lifecycleMocks.writeJobRecord.mockResolvedValueOnce('job_record_takeover')
    lifecycleMocks.updateJobRecord.mockResolvedValueOnce(undefined)

    await expect(
      processEvaluationRunJob(payload, undefined, undefined, {
        ...deps(),
        renewLease: async () => false,
        isCancellationRequested: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'execution-lease-ownership-lost' })

    expect(lifecycleMocks.finishEvaluationRunAttempt).not.toHaveBeenCalled()
    expect(lifecycleMocks.failEvaluationRunAttempt).not.toHaveBeenCalled()
  })

  it('retries an immediate consumer race until STAGED advances to QUEUED', async () => {
    lifecycleMocks.writeJobRecord.mockResolvedValueOnce('job_record_race')
    lifecycleMocks.claimEvaluationRunAttempt.mockResolvedValueOnce({ state: 'not-admitted' })
    lifecycleMocks.failEvaluationRunAttempt.mockResolvedValueOnce('retry-eligible')
    await expect(
      processEvaluationRunJob(
        payload,
        { bullJobId: 'bull_race', attemptNumber: 1, maxAttempts: 3 },
        undefined,
        deps(),
      ),
    ).rejects.toThrow('EVALUATION_RUN_NOT_ADMITTED')
    expect(lifecycleMocks.finishEvaluationRunAttempt).not.toHaveBeenCalled()
    expect(lifecycleMocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_race',
      expect.objectContaining({
        status: 'FAILED',
        failureDisposition: 'RETRY_ELIGIBLE',
      }),
    )
    expect(lifecycleMocks.generateText).not.toHaveBeenCalled()
  })
})
