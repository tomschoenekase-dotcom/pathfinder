import type { EvalCase, EvalResult as PersistedEvalResult, EvalRun } from '@prisma/client'
import {
  createEvalObservation,
  EVAL_SCHEMA_VERSION,
  scoreEvaluationChecks,
  type EvalCase as EvalCaseContract,
  type EvalResult,
} from '@pathfinder/contracts/evaluation'
import { GUEST_CHAT_PROMPT_VERSION } from '@pathfinder/contracts/prompt-contract'
import { describe, expect, it, vi } from 'vitest'

import { hashEvalCase, hashEvalObservation } from './evaluation-hash'
import {
  createOrReplayEvaluationResult,
  EvaluationResultIdentityError,
  EvaluationResultReplayConflictError,
  type EvaluationResultTerminal,
} from './evaluation-results'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const CASE_ID = '22222222-2222-4222-8222-222222222222'
const RESULT_ID = '33333333-3333-4333-8333-333333333333'
const TENANT_ID = 'tenant_1'
const VENUE_ID = 'venue_1'

const caseSnapshot: EvalCaseContract = {
  schemaVersion: EVAL_SCHEMA_VERSION,
  caseId: 'known-answer',
  category: 'known-answer',
  venue: {
    fixtureId: 'fixture-venue',
    guideMode: 'location_aware',
    placeNameUniverse: ['Tide Clock'],
    allowedPlaceNames: ['Tide Clock'],
  },
  turns: [{ role: 'user', content: 'Where is the Tide Clock?' }],
  rules: {
    requiredPhrases: [{ ruleId: 'subject', phrase: 'Tide Clock' }],
    requiredFacts: [],
    forbiddenPhrases: [],
    maxWords: 40,
    unknownAnswer: { required: false, ruleId: 'unknown-boundary', acceptablePhrases: [] },
  },
}
const caseHash = hashEvalCase(caseSnapshot)
const evalCase = {
  id: CASE_ID,
  tenantId: TENANT_ID,
  venueId: VENUE_ID,
  caseKey: caseSnapshot.caseId,
  revision: 1,
  schemaVersion: caseSnapshot.schemaVersion,
  category: caseSnapshot.category,
  caseHash,
  caseSnapshot,
  createdBy: 'operator',
  sourceType: 'SYNTHETIC',
  sourceRef: 'fixture:v1',
  createdAt: new Date('2026-08-09T00:00:00Z'),
} as unknown as EvalCase
const run = {
  id: RUN_ID,
  tenantId: TENANT_ID,
  venueId: VENUE_ID,
  identityHash: 'a'.repeat(64),
  promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
  caseManifestSnapshot: [{ caseId: CASE_ID, revision: 1, caseHash }],
} as unknown as EvalRun
const observation = createEvalObservation({
  caseId: caseSnapshot.caseId,
  answer: 'The Tide Clock is in the east atrium.',
})
const deterministicChecks = scoreEvaluationChecks(caseSnapshot, observation)
const resultEvidence: EvalResult = {
  schemaVersion: EVAL_SCHEMA_VERSION,
  caseId: caseSnapshot.caseId,
  caseHash,
  observationHash: hashEvalObservation(observation),
  passed: true,
  score: 1,
  checks: deterministicChecks,
}

function client(overrides?: { run?: EvalRun | null; evalCase?: EvalCase | null }) {
  return {
    evalRun: {
      findFirst: vi.fn().mockResolvedValue(overrides?.run === undefined ? run : overrides.run),
    },
    evalCase: {
      findFirst: vi
        .fn()
        .mockResolvedValue(overrides?.evalCase === undefined ? evalCase : overrides.evalCase),
    },
    evalResult: { findFirst: vi.fn(), create: vi.fn() },
  }
}

function params(terminal: EvaluationResultTerminal) {
  return {
    resultId: RESULT_ID,
    tenantId: TENANT_ID,
    venueId: VENUE_ID,
    runId: RUN_ID,
    evalCaseId: CASE_ID,
    caseRevision: 1,
    latencyMs: 25,
    costE8Usd: 10n,
    terminal,
  }
}

function persisted(data: Record<string, unknown>): PersistedEvalResult {
  return {
    ...data,
    observationSnapshot:
      typeof data.observationSnapshot === 'object' &&
      data.observationSnapshot !== null &&
      'toString' in data.observationSnapshot &&
      String(data.observationSnapshot) === 'DbNull'
        ? null
        : data.observationSnapshot,
    checksSnapshot:
      typeof data.checksSnapshot === 'object' &&
      data.checksSnapshot !== null &&
      'toString' in data.checksSnapshot &&
      String(data.checksSnapshot) === 'DbNull'
        ? null
        : data.checksSnapshot,
    createdAt: new Date('2026-08-09T00:00:00Z'),
  } as PersistedEvalResult
}

describe('trusted evaluation result persistence', () => {
  it('derives scored evidence and exactly replays it', async () => {
    const db = client()
    db.evalResult.findFirst.mockResolvedValueOnce(null)
    db.evalResult.create.mockImplementationOnce(async ({ data }) => persisted(data))
    const input = params({ outcome: 'SCORED', observation, result: resultEvidence })
    const created = await createOrReplayEvaluationResult({ db: db as never, ...input })
    expect(created.evalResult).toMatchObject({
      observationHash: hashEvalObservation(observation),
      passed: true,
      passedChecks: deterministicChecks.length,
      totalChecks: deterministicChecks.length,
      errorCode: null,
    })
    db.evalResult.findFirst.mockResolvedValueOnce(created.evalResult)
    await expect(
      createOrReplayEvaluationResult({ db: db as never, ...input, resultId: crypto.randomUUID() }),
    ).resolves.toMatchObject({ replayed: true })
  })

  it('stores operational outcomes with no quality fields', async () => {
    const db = client()
    db.evalResult.findFirst.mockResolvedValueOnce(null)
    db.evalResult.create.mockImplementationOnce(async ({ data }) => persisted(data))
    const created = await createOrReplayEvaluationResult({
      db: db as never,
      ...params({ outcome: 'ADMISSION_DEFERRED', errorCode: 'VENUE_AI_PAUSED' }),
    })
    expect(created.evalResult).toMatchObject({
      outcome: 'ADMISSION_DEFERRED',
      observationHash: null,
      passed: null,
      errorCode: 'VENUE_AI_PAUSED',
    })
  })

  it('rejects any changed persisted replay field', async () => {
    const seed = client()
    seed.evalResult.findFirst.mockResolvedValueOnce(null)
    seed.evalResult.create.mockImplementationOnce(async ({ data }) => persisted(data))
    const input = params({ outcome: 'SCORED', observation, result: resultEvidence })
    const created = await createOrReplayEvaluationResult({ db: seed as never, ...input })
    for (const patch of [
      { tenantId: 'other' },
      { venueId: 'other' },
      { runIdentityHash: 'b'.repeat(64) },
      { caseHash: 'c'.repeat(64) },
      { outcome: 'CANCELLED' },
      { observationHash: 'd'.repeat(64) },
      { observationSnapshot: { changed: true } },
      { checksSnapshot: [] },
      { passed: false },
      { passedChecks: 0 },
      { totalChecks: 2 },
      { errorCode: 'CHANGED' },
      { latencyMs: 26 },
      { costE8Usd: 11n },
    ]) {
      const db = client()
      db.evalResult.findFirst.mockResolvedValueOnce({ ...created.evalResult, ...patch })
      await expect(
        createOrReplayEvaluationResult({ db: db as never, ...input }),
      ).rejects.toBeInstanceOf(EvaluationResultReplayConflictError)
    }
  })

  it('rejects out-of-scope, out-of-manifest, and forged scored evidence', async () => {
    await expect(
      createOrReplayEvaluationResult({
        db: client({ run: null }) as never,
        ...params({ outcome: 'SCORED', observation, result: resultEvidence }),
      }),
    ).rejects.toBeInstanceOf(EvaluationResultIdentityError)
    await expect(
      createOrReplayEvaluationResult({
        db: client({ run: { ...run, caseManifestSnapshot: [] } as EvalRun }) as never,
        ...params({ outcome: 'SCORED', observation, result: resultEvidence }),
      }),
    ).rejects.toThrow(/exact member/)
    await expect(
      createOrReplayEvaluationResult({
        db: client() as never,
        ...params({
          outcome: 'SCORED',
          observation,
          result: { ...resultEvidence, observationHash: 'f'.repeat(64) },
        }),
      }),
    ).rejects.toThrow(/does not match/)
    const forgedChecks = deterministicChecks.map((check, index) =>
      index === 0 ? { ...check, passed: !check.passed, detail: 'Fabricated evidence' } : check,
    )
    await expect(
      createOrReplayEvaluationResult({
        db: client() as never,
        ...params({
          outcome: 'SCORED',
          observation,
          result: {
            ...resultEvidence,
            passed: forgedChecks.every((check) => check.passed),
            score: forgedChecks.filter((check) => check.passed).length / forgedChecks.length,
            checks: forgedChecks,
          },
        }),
      }),
    ).rejects.toThrow(/deterministic scoring/)
  })

  it('rejects malformed operational codes and numeric bounds', async () => {
    await expect(
      createOrReplayEvaluationResult({
        db: client() as never,
        ...params({ outcome: 'CANCELLED', errorCode: 'not-valid' }),
      }),
    ).rejects.toThrow(/errorCode/)
    await expect(
      createOrReplayEvaluationResult({
        db: client() as never,
        ...params({ outcome: 'CANCELLED', errorCode: 'USER_CANCELLED' }),
        latencyMs: -1,
      }),
    ).rejects.toThrow(/latencyMs/)
  })
})

function compileTimeTerminalAssertions(): void {
  // @ts-expect-error scored terminals cannot contain an operational error code
  const invalidScored: EvaluationResultTerminal = { outcome: 'SCORED', errorCode: 'FAIL' }
  void invalidScored
}
void compileTimeTerminalAssertions
