import { createOrReplayEvaluationCase } from '@pathfinder/db'
import { EVAL_SCHEMA_VERSION, type EvalCase } from '@pathfinder/contracts/evaluation'
import { describe, expect, it, vi } from 'vitest'

import { hashEvalCase } from './hash'

const evaluationCase: EvalCase = {
  schemaVersion: EVAL_SCHEMA_VERSION,
  caseId: 'api-db-hash-contract',
  category: 'known-answer',
  venue: {
    fixtureId: 'contract-venue',
    guideMode: 'non_location',
    placeNameUniverse: ['Map Room'],
    allowedPlaceNames: ['Map Room'],
  },
  turns: [{ role: 'user', content: 'Where is the Map Room?' }],
  rules: {
    requiredPhrases: [{ ruleId: 'place-name', phrase: 'Map Room' }],
    requiredFacts: [],
    forbiddenPhrases: [],
    maxWords: 40,
    unknownAnswer: { required: false, ruleId: 'unknown-boundary', acceptablePhrases: [] },
  },
}

describe('API/DB evaluation case hash contract', () => {
  it('persists the exact API kernel hash under pathfinder-eval-case-v1', async () => {
    const db = {
      evalCase: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }) => ({
          ...data,
          createdAt: new Date('2026-08-09T00:00:00Z'),
        })),
      },
    }
    const created = await createOrReplayEvaluationCase({
      db: db as never,
      caseId: '44444444-4444-4444-8444-444444444444',
      identity: {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        caseKey: evaluationCase.caseId,
        revision: 1,
        schemaVersion: evaluationCase.schemaVersion,
        category: evaluationCase.category,
        caseSnapshot: evaluationCase,
        createdBy: 'contract-test',
        sourceType: 'SYNTHETIC',
        sourceRef: 'contract:v1',
      },
    })
    expect(created.evalCase.caseHash).toBe(hashEvalCase(evaluationCase))
  })
})
