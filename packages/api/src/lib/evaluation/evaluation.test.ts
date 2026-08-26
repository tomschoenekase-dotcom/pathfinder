import { describe, expect, it } from 'vitest'

import { GUEST_CHAT_PROMPT_VERSION } from '../venue-context'
import {
  createEvalObservation,
  EvalCaseSchema,
  EvalObservationInputSchema,
  EvalObservationSchema,
  EvalResultSchema,
} from './contracts'
import { hashEvalCase, hashEvalObservation } from './hash'
import { evaluateCorpus } from './scoring'
import {
  SYNTHETIC_LEXICAL_BASELINE_INPUTS,
  SYNTHETIC_LEXICAL_DEGRADED_INPUT,
  SYNTHETIC_LEXICAL_SMOKE_CASES,
  SYNTHETIC_LEXICAL_SMOKE_THRESHOLDS,
} from './synthetic-corpus'

function baselineEvaluation() {
  return evaluateCorpus(
    SYNTHETIC_LEXICAL_SMOKE_CASES,
    SYNTHETIC_LEXICAL_BASELINE_INPUTS,
    SYNTHETIC_LEXICAL_SMOKE_THRESHOLDS,
  )
}

describe('PathFinder deterministic lexical smoke evaluation', () => {
  it('uses the production-owned guest-chat prompt version and excludes timestamps', () => {
    expect(EvalObservationSchema.shape.expectedPromptContractVersion.value).toBe(
      GUEST_CHAT_PROMPT_VERSION,
    )
    const observation = createEvalObservation({ caseId: 'synthetic-case', answer: 'Answer' })
    expect(observation.expectedPromptContractVersion).toBe(GUEST_CHAT_PROMPT_VERSION)
    expect(() =>
      EvalObservationInputSchema.parse({
        caseId: 'synthetic-case',
        answer: 'Synthetic answer',
        createdAt: '2026-08-08T00:00:00.000Z',
      }),
    ).toThrow()
  })

  it('validates a bounded two-venue corpus with meaningful category rules', () => {
    expect(SYNTHETIC_LEXICAL_SMOKE_CASES).toHaveLength(5)
    expect(new Set(SYNTHETIC_LEXICAL_SMOKE_CASES.map((item) => item.venue.fixtureId))).toEqual(
      new Set(['synthetic-lighthouse-commons', 'synthetic-cedar-archive']),
    )

    const knownCase = SYNTHETIC_LEXICAL_SMOKE_CASES[0]!
    expect(() =>
      EvalCaseSchema.parse({
        ...knownCase,
        turns: [{ role: 'assistant', content: 'Wrong starting role' }],
      }),
    ).toThrow('Turns must alternate')
    expect(() =>
      EvalCaseSchema.parse({
        ...knownCase,
        rules: { ...knownCase.rules, requiredPhrases: [], requiredFacts: [] },
      }),
    ).toThrow('requires at least one required phrase or fact')
    expect(() =>
      EvalCaseSchema.parse({
        ...knownCase,
        turns: [{ role: 'user', content: 'x'.repeat(2_001) }],
      }),
    ).toThrow()
  })

  it('rejects duplicate rules, overlapping required/forbidden phrases, and incomplete place sets', () => {
    const evalCase = SYNTHETIC_LEXICAL_SMOKE_CASES[0]!
    expect(() =>
      EvalCaseSchema.parse({
        ...evalCase,
        rules: {
          ...evalCase.rules,
          forbiddenPhrases: [
            ...evalCase.rules.forbiddenPhrases,
            { ruleId: 'subject-name', phrase: 'another phrase' },
          ],
        },
      }),
    ).toThrow('Rule IDs must be unique')
    expect(() =>
      EvalCaseSchema.parse({
        ...evalCase,
        rules: {
          ...evalCase.rules,
          forbiddenPhrases: [
            ...evalCase.rules.forbiddenPhrases,
            { ruleId: 'forbid-subject', phrase: 'Tide Clock' },
          ],
        },
      }),
    ).toThrow()
    expect(() =>
      EvalCaseSchema.parse({
        ...evalCase,
        venue: { ...evalCase.venue, allowedPlaceNames: ['Undeclared Place'] },
      }),
    ).toThrow('subset of the complete universe')

    expect(
      EvalCaseSchema.parse({
        ...evalCase,
        venue: { ...evalCase.venue, placeNameUniverse: [], allowedPlaceNames: [] },
      }).venue.placeNameUniverse,
    ).toEqual([])
    const leakCase = SYNTHETIC_LEXICAL_SMOKE_CASES.find(
      (item) => item.category === 'tenant-leak-canary',
    )!
    expect(() =>
      EvalCaseSchema.parse({
        ...leakCase,
        venue: { ...leakCase.venue, placeNameUniverse: [], allowedPlaceNames: [] },
      }),
    ).toThrow('require a declared disallowed place')
  })

  it('requires a real alternating multi-turn context ending in a user turn', () => {
    const multiTurn = SYNTHETIC_LEXICAL_SMOKE_CASES.find(
      (item) => item.category === 'multi-turn-context',
    )!
    expect(() =>
      EvalCaseSchema.parse({ ...multiTurn, turns: multiTurn.turns.slice(0, 2) }),
    ).toThrow()
    expect(() =>
      EvalCaseSchema.parse({
        ...multiTurn,
        turns: [multiTurn.turns[0], multiTurn.turns[2]],
      }),
    ).toThrow()
  })

  it('normalizes Unicode to NFC for matching and canonical hashes', () => {
    const source = SYNTHETIC_LEXICAL_SMOKE_CASES[0]!
    const composedCase = EvalCaseSchema.parse({
      ...source,
      caseId: 'unicode-normalization',
      turns: [{ role: 'user', content: 'Is Café open?' }],
      rules: {
        ...source.rules,
        requiredPhrases: [{ ruleId: 'accented-subject', phrase: 'Café' }],
        requiredFacts: [],
      },
    })
    const decomposedCase = EvalCaseSchema.parse({
      ...composedCase,
      turns: [{ role: 'user', content: 'Is Cafe\u0301 open?' }],
      rules: {
        ...composedCase.rules,
        requiredPhrases: [{ ruleId: 'accented-subject', phrase: 'Cafe\u0301' }],
      },
    })
    const input = EvalObservationInputSchema.parse({
      caseId: composedCase.caseId,
      answer: 'Cafe\u0301 is open.',
    })

    expect(hashEvalCase(decomposedCase)).toBe(hashEvalCase(composedCase))
    expect(
      evaluateCorpus([composedCase], [input], {
        minimumCasePassRate: 1,
        minimumCheckPassRate: 1,
        categoryMinimums: [{ category: 'known-answer', minimumPassRate: 1 }],
      }).aggregate.passed,
    ).toBe(true)
  })

  it('produces pinned, domain-separated SHA-256 identities', () => {
    expect(GUEST_CHAT_PROMPT_VERSION).toBe('guest-chat-prompt-v8')
    const caseHash = hashEvalCase(SYNTHETIC_LEXICAL_SMOKE_CASES[0]!)
    const observationHash = hashEvalObservation(
      createEvalObservation(SYNTHETIC_LEXICAL_BASELINE_INPUTS[0]!),
    )

    expect(caseHash).toBe('ff7807fad686cfd13f08f62f669a46e9e78d6a8c4c5f38113774dd3daa7bf896')
    expect(observationHash).toBe('1e191510e5746254572c77a2adf0d5041639ed0cdc36d3a5c2478e5c5fb97dad')
    expect(observationHash).not.toBe(caseHash)
  })

  it('passes the lexical smoke baseline and aggregate thresholds', () => {
    const { observations, results, aggregate } = baselineEvaluation()

    expect(
      observations.every(
        (item) => item.expectedPromptContractVersion === GUEST_CHAT_PROMPT_VERSION,
      ),
    ).toBe(true)
    expect(results.every((result) => result.passed)).toBe(true)
    expect(aggregate).toMatchObject({
      passed: true,
      caseCount: 5,
      passedCaseCount: 5,
      casePassRate: 1,
      checkPassRate: 1,
    })
  })

  it('lexically detects a disallowed place without caller-supplied mention metadata', () => {
    expect(() =>
      EvalObservationInputSchema.parse({
        ...SYNTHETIC_LEXICAL_DEGRADED_INPUT,
        mentionedPlaceNames: [],
      }),
    ).toThrow()

    const degradedInputs = SYNTHETIC_LEXICAL_BASELINE_INPUTS.map((input) =>
      input.caseId === SYNTHETIC_LEXICAL_DEGRADED_INPUT.caseId
        ? SYNTHETIC_LEXICAL_DEGRADED_INPUT
        : input,
    )
    const degraded = evaluateCorpus(
      SYNTHETIC_LEXICAL_SMOKE_CASES,
      degradedInputs,
      SYNTHETIC_LEXICAL_SMOKE_THRESHOLDS,
    )
    const result = degraded.results.find(
      (item) => item.caseId === SYNTHETIC_LEXICAL_DEGRADED_INPUT.caseId,
    )!
    expect(degraded.aggregate.passed).toBe(false)
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: 'fact:subject-location', passed: false }),
        expect.objectContaining({ checkId: 'forbidden:cross-venue-name', passed: false }),
        expect.objectContaining({ checkId: 'place-allowlist', passed: false }),
      ]),
    )
  })

  it('rejects forged pass flags, scores, and duplicate check IDs', () => {
    const result = baselineEvaluation().results[0]!
    expect(() => EvalResultSchema.parse({ ...result, passed: false })).toThrow(
      'pass flag contradicts checks',
    )
    expect(() => EvalResultSchema.parse({ ...result, score: 0.5 })).toThrow(
      'score contradicts checks',
    )
    expect(() =>
      EvalResultSchema.parse({ ...result, checks: [...result.checks, result.checks[0]] }),
    ).toThrow('Check IDs must be unique')
    expect(() =>
      evaluateCorpus(
        SYNTHETIC_LEXICAL_SMOKE_CASES,
        [result, ...SYNTHETIC_LEXICAL_BASELINE_INPUTS.slice(1)] as never,
        SYNTHETIC_LEXICAL_SMOKE_THRESHOLDS,
      ),
    ).toThrow()
  })

  it('rejects missing, duplicate, and mismatched observation inputs', () => {
    expect(() =>
      evaluateCorpus(
        SYNTHETIC_LEXICAL_SMOKE_CASES,
        SYNTHETIC_LEXICAL_BASELINE_INPUTS.slice(1),
        SYNTHETIC_LEXICAL_SMOKE_THRESHOLDS,
      ),
    ).toThrow('must match the evaluation corpus exactly')
    expect(() =>
      evaluateCorpus(
        SYNTHETIC_LEXICAL_SMOKE_CASES,
        [SYNTHETIC_LEXICAL_BASELINE_INPUTS[0]!, ...SYNTHETIC_LEXICAL_BASELINE_INPUTS],
        SYNTHETIC_LEXICAL_SMOKE_THRESHOLDS,
      ),
    ).toThrow('must have unique case IDs')
    expect(() =>
      evaluateCorpus(
        SYNTHETIC_LEXICAL_SMOKE_CASES,
        [
          { ...SYNTHETIC_LEXICAL_BASELINE_INPUTS[0]!, caseId: 'unrelated-case' },
          ...SYNTHETIC_LEXICAL_BASELINE_INPUTS.slice(1),
        ],
        SYNTHETIC_LEXICAL_SMOKE_THRESHOLDS,
      ),
    ).toThrow('must match the evaluation corpus exactly')
  })

  it('cannot pass with an unthresholded corpus category', () => {
    const thresholdsWithoutMultiTurn = {
      ...SYNTHETIC_LEXICAL_SMOKE_THRESHOLDS,
      categoryMinimums: SYNTHETIC_LEXICAL_SMOKE_THRESHOLDS.categoryMinimums.filter(
        (entry) => entry.category !== 'multi-turn-context',
      ),
    }
    expect(
      evaluateCorpus(
        SYNTHETIC_LEXICAL_SMOKE_CASES,
        SYNTHETIC_LEXICAL_BASELINE_INPUTS,
        thresholdsWithoutMultiTurn,
      ).aggregate.passed,
    ).toBe(false)
  })
})
