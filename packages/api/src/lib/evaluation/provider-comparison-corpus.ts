import { GOLDEN_VENUE_EVAL_CASES } from './golden-venue-corpus'

const REQUIRED_FAMILIES = [
  'temporal-update',
  'contradictory-source',
  'missing-answer',
  'staff-private-separation',
  'multi-turn-context',
] as const

export const PROVIDER_COMPARISON_CASES = REQUIRED_FAMILIES.map((family) => {
  const evalCase = GOLDEN_VENUE_EVAL_CASES.find(
    (candidate) =>
      candidate.dimensions?.language === 'en' && candidate.dimensions.families?.includes(family),
  )
  if (!evalCase) throw new Error(`Golden venue corpus is missing comparison family ${family}`)
  return evalCase
})

export const PROVIDER_COMPARISON_CASE_METRICS = {
  [PROVIDER_COMPARISON_CASES[0]!.caseId]: ['factual-extraction', 'temporal-error'],
  [PROVIDER_COMPARISON_CASES[1]!.caseId]: ['factual-extraction', 'temporal-error'],
  [PROVIDER_COMPARISON_CASES[2]!.caseId]: ['missed-entity', 'escalation'],
  [PROVIDER_COMPARISON_CASES[3]!.caseId]: ['factual-extraction', 'invalid-output'],
  [PROVIDER_COMPARISON_CASES[4]!.caseId]: ['missed-entity', 'invalid-output'],
} as const
