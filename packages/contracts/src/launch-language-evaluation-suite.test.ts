import { describe, expect, it } from 'vitest'

import {
  buildLaunchLanguageEvaluationSuite,
  LAUNCH_LANGUAGE_EVALUATION_CONTRACTS,
  LAUNCH_LANGUAGE_EVALUATION_SUITE_VERSION,
} from './launch-language-evaluation-suite'

const preview = {
  venue: { id: 'venue_1', name: 'Riverside Aquarium' },
  experience: {
    places: [{ name: 'Penguin Cove' }],
    knowledgeEntries: [],
  },
}

describe('launch-language evaluation suite', () => {
  it('pins paired grounded and fallback cases for every launch language', () => {
    const suite = buildLaunchLanguageEvaluationSuite(preview)
    expect(LAUNCH_LANGUAGE_EVALUATION_SUITE_VERSION).toBe(
      'torchiko-launch-language-evaluation-suite-v1',
    )
    expect(suite).toHaveLength(20)
    expect(new Set(suite.map((item) => item.evalCase.caseId))).toHaveLength(20)
    expect(new Set(suite.map((item) => item.language))).toEqual(
      new Set(LAUNCH_LANGUAGE_EVALUATION_CONTRACTS.map((item) => item.code)),
    )
    for (const language of LAUNCH_LANGUAGE_EVALUATION_CONTRACTS) {
      const cases = suite.filter((item) => item.language === language.code)
      expect(cases.map((item) => item.dimension)).toEqual([
        'launch-language-grounded',
        'launch-language-fallback',
      ])
      expect(cases.every((item) => item.evalCase.dimensions?.language === language.code)).toBe(true)
    }
  })

  it('requires both exact package truth and a selected-language marker for grounded answers', () => {
    const grounded = buildLaunchLanguageEvaluationSuite(preview).find(
      (item) => item.language === 'ar' && item.dimension === 'launch-language-grounded',
    )!
    expect(grounded.evalCase.rules.requiredFacts).toEqual([
      { ruleId: 'approved-venue-name', acceptablePhrases: ['Riverside Aquarium'] },
      {
        ruleId: 'selected-language',
        acceptablePhrases: ['اسم هذا المكان هو', 'يُسمى هذا المكان', 'هذا المكان هو'],
      },
    ])
  })

  it('requires localized honest uncertainty without inventing a package policy', () => {
    const fallback = buildLaunchLanguageEvaluationSuite(preview).find(
      (item) => item.language === 'ja' && item.dimension === 'launch-language-fallback',
    )!
    expect(fallback.evalCase.category).toBe('unknown-answer')
    expect(fallback.evalCase.rules.unknownAnswer).toEqual({
      required: true,
      ruleId: 'unknown-boundary',
      acceptablePhrases: ['その規則についての情報はありません', 'その情報はありません'],
    })
  })
})
