import { describe, expect, it } from 'vitest'

import {
  COMPANY_BRAIN_RETRIEVAL_QUESTIONS,
  scoreCompanyBrainRetrievalAnswer,
  type CompanyBrainRetrievalCase,
} from './company-brain-retrieval'

const currentDecisionCase: CompanyBrainRetrievalCase = {
  id: 'current-pricing-decision',
  question: COMPANY_BRAIN_RETRIEVAL_QUESTIONS[6]!,
  category: 'CURRENT_DECISION',
  compactContext: { organizationId: 'org-1', summary: 'Mature museum account.' },
  knowledgeResults: [
    {
      id: 'knowledge-old',
      authority: 'SUPERSEDED',
      snippet: 'Custom characters are included at no charge.',
      supersession: { supersededById: 'knowledge-current' },
    },
    {
      id: 'knowledge-current',
      authority: 'AUTHORITATIVE_CURRENT',
      snippet: 'Custom characters use add-on pricing.',
      provenance: [{ sourceId: 'meeting-2026-08-15' }],
    },
  ],
  expectedFacts: ['Custom characters use add-on pricing.'],
  requiredSourceIds: ['knowledge-current', 'meeting-2026-08-15'],
  forbiddenClaims: ['Custom characters are included at no charge.'],
  deepKnowledgeRequired: true,
  maxInputBytes: 8_000,
  maxAnswerBytes: 2_000,
}

describe('Company Brain retrieval evaluation', () => {
  it('covers the required provider-backed replay questions', () => {
    expect(COMPANY_BRAIN_RETRIEVAL_QUESTIONS).toHaveLength(8)
  })

  it('scores grounding, supersession, retrieval economy, and payload size', () => {
    const result = scoreCompanyBrainRetrievalAnswer(currentDecisionCase, {
      answer: 'The old arrangement is no longer current.',
      facts: ['Custom characters use add-on pricing.'],
      sourceIds: ['knowledge-current', 'meeting-2026-08-15'],
      usedDeepKnowledge: true,
      uncertainty: [],
    })
    expect(result).toMatchObject({
      passed: true,
      score: 1,
      checks: {
        factualCorrectness: true,
        sourceGrounding: true,
        currentVsHistorical: true,
        retrievalEconomy: true,
        noHallucinatedSource: true,
        payloadEfficiency: true,
      },
    })
  })

  it('fails stale claims, fabricated sources, and unnecessary deep retrieval independently', () => {
    const result = scoreCompanyBrainRetrievalAnswer(
      { ...currentDecisionCase, deepKnowledgeRequired: false },
      {
        answer: 'Custom characters are included at no charge.',
        facts: [],
        sourceIds: ['invented-source'],
        usedDeepKnowledge: true,
        uncertainty: [],
      },
    )
    expect(result.checks).toMatchObject({
      factualCorrectness: false,
      sourceGrounding: false,
      currentVsHistorical: false,
      retrievalEconomy: false,
      noHallucinatedSource: false,
    })
    expect(result.passed).toBe(false)
  })
})
