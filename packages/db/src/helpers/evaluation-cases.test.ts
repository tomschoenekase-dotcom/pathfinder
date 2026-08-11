import type { EvalCase } from '@prisma/client'
import {
  EVAL_SCHEMA_VERSION,
  type EvalCase as EvalCaseContract,
} from '@pathfinder/contracts/evaluation'
import { describe, expect, it, vi } from 'vitest'

import {
  createOrReplayEvaluationCase,
  EvaluationCaseReplayConflictError,
  type EvaluationCaseIdentity,
} from './evaluation-cases'
import { hashEvalCase } from './evaluation-hash'

const CASE_ID = '22222222-2222-4222-8222-222222222222'
const CASE_SNAPSHOT: EvalCaseContract = {
  schemaVersion: EVAL_SCHEMA_VERSION,
  caseId: 'known-answer',
  category: 'known-answer',
  venue: {
    fixtureId: 'fixture-venue',
    guideMode: 'location_aware',
    placeNameUniverse: ['Café'],
    allowedPlaceNames: ['Café'],
  },
  turns: [{ role: 'user', content: 'Where is the Café?' }],
  rules: {
    requiredPhrases: [{ ruleId: 'place-name', phrase: 'Café' }],
    requiredFacts: [],
    forbiddenPhrases: [],
    maxWords: 40,
    unknownAnswer: { required: false, ruleId: 'unknown-boundary', acceptablePhrases: [] },
  },
}

const identity = (overrides: Partial<EvaluationCaseIdentity> = {}): EvaluationCaseIdentity => ({
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  caseKey: CASE_SNAPSHOT.caseId,
  revision: 1,
  schemaVersion: CASE_SNAPSHOT.schemaVersion,
  category: CASE_SNAPSHOT.category,
  caseSnapshot: CASE_SNAPSHOT,
  createdBy: 'operator_1',
  sourceType: 'SYNTHETIC_CORPUS',
  sourceRef: 'synthetic-corpus:v1',
  ...overrides,
})

function client() {
  return { evalCase: { findFirst: vi.fn(), create: vi.fn() } }
}

function row(data: Record<string, unknown>): EvalCase {
  return { ...data, createdAt: new Date('2026-08-09T00:00:00.000Z') } as EvalCase
}

describe('evaluation case persistence', () => {
  it('uses the shared API/kernel case hash and replays the exact revision', async () => {
    const db = client()
    db.evalCase.findFirst.mockResolvedValueOnce(null)
    db.evalCase.create.mockImplementationOnce(async ({ data }) => row(data))
    const created = await createOrReplayEvaluationCase({
      db: db as never,
      caseId: CASE_ID,
      identity: identity(),
    })
    expect(created.replayed).toBe(false)
    expect(created.evalCase.caseHash).toBe(hashEvalCase(CASE_SNAPSHOT))

    db.evalCase.findFirst.mockResolvedValueOnce(created.evalCase)
    await expect(
      createOrReplayEvaluationCase({ db: db as never, caseId: CASE_ID, identity: identity() }),
    ).resolves.toEqual({ evalCase: created.evalCase, replayed: true })
    expect(db.evalCase.create).toHaveBeenCalledOnce()
  })

  it('canonicalizes NFC for exact snapshot identity', async () => {
    const firstDb = client()
    firstDb.evalCase.findFirst.mockResolvedValueOnce(null)
    firstDb.evalCase.create.mockImplementationOnce(async ({ data }) => row(data))
    const first = await createOrReplayEvaluationCase({
      db: firstDb as never,
      caseId: CASE_ID,
      identity: identity(),
    })
    const decomposed = {
      ...CASE_SNAPSHOT,
      venue: {
        ...CASE_SNAPSHOT.venue,
        placeNameUniverse: ['Cafe\u0301'],
        allowedPlaceNames: ['Cafe\u0301'],
      },
      turns: [{ role: 'user' as const, content: 'Where is the Cafe\u0301?' }],
      rules: {
        ...CASE_SNAPSHOT.rules,
        requiredPhrases: [{ ruleId: 'place-name', phrase: 'Cafe\u0301' }],
      },
    }
    const replayDb = client()
    replayDb.evalCase.findFirst.mockResolvedValueOnce(first.evalCase)
    await expect(
      createOrReplayEvaluationCase({
        db: replayDb as never,
        caseId: CASE_ID,
        identity: identity({ caseSnapshot: decomposed }),
      }),
    ).resolves.toMatchObject({ replayed: true })
  })

  it('conflicts when immutable content or provenance changes', async () => {
    const createDb = client()
    createDb.evalCase.findFirst.mockResolvedValueOnce(null)
    createDb.evalCase.create.mockImplementationOnce(async ({ data }) => row(data))
    const created = await createOrReplayEvaluationCase({
      db: createDb as never,
      caseId: CASE_ID,
      identity: identity(),
    })
    for (const changed of [
      identity({
        caseSnapshot: {
          ...CASE_SNAPSHOT,
          turns: [{ role: 'user', content: 'Changed question?' }],
        },
      }),
      identity({ sourceRef: 'synthetic-corpus:v2' }),
    ]) {
      const replayDb = client()
      replayDb.evalCase.findFirst.mockResolvedValueOnce(created.evalCase)
      await expect(
        createOrReplayEvaluationCase({ db: replayDb as never, caseId: CASE_ID, identity: changed }),
      ).rejects.toBeInstanceOf(EvaluationCaseReplayConflictError)
    }
  })

  it('rejects invalid or metadata-mismatched case contracts', async () => {
    await expect(
      createOrReplayEvaluationCase({
        db: client() as never,
        caseId: CASE_ID,
        identity: identity({ caseSnapshot: { ...CASE_SNAPSHOT, turns: [] } as never }),
      }),
    ).rejects.toThrow(/not a valid EvalCase/)
    await expect(
      createOrReplayEvaluationCase({
        db: client() as never,
        caseId: CASE_ID,
        identity: identity({ caseKey: 'different-case' }),
      }),
    ).rejects.toThrow(/must match/)
  })
})
