import { describe, expect, it } from 'vitest'

import { SUPPORTED_CHAT_LANGUAGES } from '../../schemas/chat'
import { EvalCaseSchema } from './contracts'
import { evaluateCorpus } from './scoring'
import {
  GOLDEN_VENUE_BASELINE_INPUTS,
  GOLDEN_VENUE_DEGRADED_INPUT,
  GOLDEN_VENUE_DEGRADED_REVIEW_EXPECTATION,
  GOLDEN_VENUE_EVAL_CASES,
  GOLDEN_VENUE_REGRESSION_THRESHOLDS,
} from './golden-venue-corpus'

describe('Golden Venue representative evaluation corpus', () => {
  it('pins a unique 100-case stratified matrix with explicit coverage dimensions', () => {
    expect(GOLDEN_VENUE_EVAL_CASES).toHaveLength(100)
    expect(new Set(GOLDEN_VENUE_EVAL_CASES.map((item) => item.caseId))).toHaveLength(100)
    expect(GOLDEN_VENUE_EVAL_CASES.every((item) => item.dimensions !== undefined)).toBe(true)

    const supportedLanguages = SUPPORTED_CHAT_LANGUAGES.map((language) => language.code)
    const corpusLanguages = new Set(
      GOLDEN_VENUE_EVAL_CASES.map((item) => item.dimensions!.language),
    )
    expect(corpusLanguages).toEqual(new Set(supportedLanguages))
    for (const language of supportedLanguages) {
      expect(
        GOLDEN_VENUE_EVAL_CASES.filter((item) => item.dimensions!.language === language),
      ).toHaveLength(10)
    }

    expect(new Set(GOLDEN_VENUE_EVAL_CASES.map((item) => item.venue.fixtureId)).size).toBe(4)
    expect(new Set(GOLDEN_VENUE_EVAL_CASES.map((item) => item.category))).toEqual(
      new Set([
        'known-answer',
        'unknown-answer',
        'operational-closure',
        'tenant-leak-canary',
        'multi-turn-context',
      ]),
    )
    expect(new Set(GOLDEN_VENUE_EVAL_CASES.map((item) => item.dimensions!.risk))).toEqual(
      new Set(['low', 'moderate', 'high']),
    )
    expect(new Set(GOLDEN_VENUE_EVAL_CASES.map((item) => item.dimensions!.intent))).toEqual(
      new Set(['directions', 'policy', 'availability', 'privacy', 'accessibility']),
    )
    expect(
      new Set(GOLDEN_VENUE_EVAL_CASES.map((item) => item.dimensions!.locationContext)),
    ).toEqual(new Set(['exhibit', 'arrival', 'whole-venue', 'offsite']))
  })

  it('keeps coverage dimensions strict while preserving legacy v1 cases', () => {
    const legacyCase = GOLDEN_VENUE_EVAL_CASES[0]!
    expect(
      EvalCaseSchema.parse({ ...legacyCase, dimensions: undefined }).dimensions,
    ).toBeUndefined()
    expect(() =>
      EvalCaseSchema.parse({
        ...legacyCase,
        dimensions: { ...legacyCase.dimensions, unsupportedDimension: true },
      }),
    ).toThrow()
  })

  it('passes the frozen provider-free baseline at no-regression thresholds', () => {
    const evaluated = evaluateCorpus(
      GOLDEN_VENUE_EVAL_CASES,
      GOLDEN_VENUE_BASELINE_INPUTS,
      GOLDEN_VENUE_REGRESSION_THRESHOLDS,
    )

    expect(evaluated.aggregate).toMatchObject({
      passed: true,
      caseCount: 100,
      passedCaseCount: 100,
      casePassRate: 1,
      checkPassRate: 1,
    })
  })

  it('retains a deliberate regression and routes it toward human rejection', () => {
    const degradedInputs = GOLDEN_VENUE_BASELINE_INPUTS.map((input) =>
      input.caseId === GOLDEN_VENUE_DEGRADED_INPUT.caseId ? GOLDEN_VENUE_DEGRADED_INPUT : input,
    )
    const evaluated = evaluateCorpus(
      GOLDEN_VENUE_EVAL_CASES,
      degradedInputs,
      GOLDEN_VENUE_REGRESSION_THRESHOLDS,
    )
    const failed = evaluated.results.find(
      (result) => result.caseId === GOLDEN_VENUE_DEGRADED_INPUT.caseId,
    )!

    expect(evaluated.aggregate.passed).toBe(false)
    expect(failed.passed).toBe(false)
    expect(failed.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: 'required:place-name', passed: false }),
        expect.objectContaining({ checkId: 'fact:direction-detail', passed: false }),
        expect.objectContaining({ checkId: 'forbidden:cross-tenant-secret', passed: false }),
        expect.objectContaining({ checkId: 'forbidden:private-note-marker', passed: false }),
      ]),
    )
    expect(GOLDEN_VENUE_DEGRADED_REVIEW_EXPECTATION).toEqual({
      retained: true,
      suggestedDisposition: 'REJECTED',
      reason: 'A tenant-boundary canary appeared and required answer markers were absent.',
    })
  })
})
