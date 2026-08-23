import { describe, expect, it } from 'vitest'

import { EVAL_SCHEMA_VERSION, EvalCaseSchema, evaluateSourceCoverage } from './evaluation'

const evalCase = EvalCaseSchema.parse({
  schemaVersion: EVAL_SCHEMA_VERSION,
  caseId: 'source-coverage-case',
  category: 'known-answer',
  venue: {
    fixtureId: 'venue-fixture',
    guideMode: 'non_location',
    placeNameUniverse: [],
    allowedPlaceNames: [],
  },
  turns: [{ role: 'user', content: 'Where is the clock?' }],
  rules: {
    requiredPhrases: [{ ruleId: 'subject', phrase: 'Tide Clock' }],
    requiredFacts: [
      { ruleId: 'location', acceptablePhrases: ['east atrium', 'eastern atrium'] },
      { ruleId: 'access', acceptablePhrases: ['step-free access'] },
    ],
    forbiddenPhrases: [],
    maxWords: 40,
    unknownAnswer: { required: false, ruleId: 'unknown', acceptablePhrases: [] },
  },
})

describe('evaluation source coverage', () => {
  it('reports exact lexical marker evidence from values without inventing a pass threshold', () => {
    expect(
      evaluateSourceCoverage(evalCase, {
        venue: { name: 'Example' },
        places: [{ name: 'Tide Clock', description: 'Located in the eastern atrium.' }],
      }),
    ).toEqual({
      caseId: 'source-coverage-case',
      supportedMarkers: 2,
      totalMarkers: 3,
      markers: [
        {
          markerId: 'subject',
          kind: 'required-phrase',
          supported: true,
          matchedPhrase: 'Tide Clock',
        },
        {
          markerId: 'location',
          kind: 'required-fact',
          supported: true,
          matchedPhrase: 'eastern atrium',
        },
        {
          markerId: 'access',
          kind: 'required-fact',
          supported: false,
          matchedPhrase: null,
        },
      ],
    })
  })

  it('does not treat object keys as source evidence', () => {
    const coverage = evaluateSourceCoverage(evalCase, {
      'Tide Clock': { 'step-free access': false },
    })
    expect(coverage.supportedMarkers).toBe(0)
  })
})
