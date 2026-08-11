import { describe, expect, it, vi } from 'vitest'

import { executeFrozenEvaluationRun, type EvaluationRunnerDependencies } from './evaluation-run'

const id = '11111111-1111-4111-8111-111111111111'
const hash = 'a'.repeat(64)
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
const payload = { tenantId: 't1', venueId: 'v1', runId: id, runIdentityHash: hash }
function deps(overrides: Partial<EvaluationRunnerDependencies> = {}): EvaluationRunnerDependencies {
  return {
    loadRun: async () => ({
      id,
      tenantId: 't1',
      venueId: 'v1',
      identityHash: hash,
      caseManifestSnapshot: [{ caseId: id, revision: 1, caseHash: hash }],
      modelProvider: 'anthropic',
      modelName: 'frozen-model',
      declaredBudgetCeilingE8Usd: 10n,
    }),
    loadCases: async () => [{ id, revision: 1, caseHash: hash, caseSnapshot: evalCase }],
    evaluate: async () => ({
      answer: 'It is here',
      latencyMs: 4,
      costE8Usd: 3n,
      modelProvider: 'anthropic',
      modelName: 'frozen-model',
    }),
    persist: vi.fn(async () => undefined),
    ...overrides,
  }
}
describe('executeFrozenEvaluationRun', () => {
  it('scores quality separately and records bounded cost', async () => {
    const subject = deps()
    const result = await executeFrozenEvaluationRun(payload, subject, { finalAttempt: true })
    expect(result).toEqual({ processed: 1, costE8Usd: 3n })
    expect(subject.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({ outcome: 'SCORED', costE8Usd: 3n }),
      }),
    )
  })
  it('lets BullMQ retry operational failures before writing terminal evidence', async () => {
    const subject = deps({
      evaluate: vi.fn(async () => {
        throw new Error('provider down')
      }),
    })
    await expect(
      executeFrozenEvaluationRun(payload, subject, { finalAttempt: false }),
    ).rejects.toThrow('provider down')
    expect(subject.persist).not.toHaveBeenCalled()
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
  it('hard-stops cost above the frozen ceiling', async () => {
    const subject = deps({
      evaluate: async () => ({
        answer: 'here',
        latencyMs: 2,
        costE8Usd: 11n,
        modelProvider: 'anthropic',
        modelName: 'frozen-model',
      }),
    })
    const result = await executeFrozenEvaluationRun(payload, subject, { finalAttempt: true })
    expect(result.costE8Usd).toBe(0n)
    expect(subject.persist).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: expect.objectContaining({ outcome: 'BUDGET_BLOCKED' }) }),
    )
  })
  it('rejects cross-tenant or changed frozen identities before evaluation', async () => {
    const evaluate = vi.fn()
    const subject = deps({
      loadRun: async () => ({
        id,
        tenantId: 'other',
        venueId: 'v1',
        identityHash: hash,
        caseManifestSnapshot: [],
        modelProvider: 'anthropic',
        modelName: 'frozen-model',
        declaredBudgetCeilingE8Usd: 10n,
      }),
      evaluate,
    })
    await expect(
      executeFrozenEvaluationRun(payload, subject, { finalAttempt: true }),
    ).rejects.toThrow('IDENTITY_MISMATCH')
    expect(evaluate).not.toHaveBeenCalled()
  })
})
